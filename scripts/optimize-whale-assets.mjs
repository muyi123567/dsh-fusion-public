#!/usr/bin/env node
// Execute only in the authorized Instabox checkout; never installs dependencies.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'packages/client/src/features/whale/ambient/assets');
const toolRoot = resolve(process.env.WHALE_ASSET_TOOLS ?? resolve(assets, 'tools'));
const req = createRequire(resolve(toolRoot, 'package.json'));
const versions = { '@gltf-transform/core': '4.2.1', '@gltf-transform/functions': '4.2.1',
  '@gltf-transform/extensions': '4.2.1', meshoptimizer: '0.22.0', sharp: '0.33.5' };
for (const [name, version] of Object.entries(versions)) {
  // Read package metadata without relying on package.json subpath exports.
  let folder = dirname(req.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
      if (pkg.name === name) {
        if (pkg.version !== version) throw new Error(name + ': expected ' + version + ', got ' + pkg.version);
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(folder);
    if (parent === folder) throw new Error('Cannot locate metadata for ' + name);
    folder = parent;
  }
}
const load = name => import(pathToFileURL(req.resolve(name)).href);
const { NodeIO } = await load('@gltf-transform/core');
const { ALL_EXTENSIONS } = await load('@gltf-transform/extensions');
const { weld, simplify, prune, dedup } = await load('@gltf-transform/functions');
const { MeshoptSimplifier } = await load('meshoptimizer');
const { default: sharp } = await load('sharp');
await MeshoptSimplifier.ready;
const size = Number(process.argv[2] ?? 1024);
if (![512, 1024].includes(size)) throw new Error('Usage: node scripts/optimize-whale-assets.mjs [1024|512]');
const input = resolve(root, 'packages/client/public/whale-assets/humpback-whale-light.glb');
const output = resolve(assets, 'humpback-whale-panel-' + size + '.glb');
const reportPath = output + '.json';
for (const path of [output, reportPath]) {
  try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Refusing to overwrite ' + path);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(input);
if (sha(source) !== 'c07b1cec69fb3292165c51d00acf224809476b6d9d899c3a810d6050e9611c58')
  throw new Error('Source SHA differs from the reviewed CC0 source');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
function assertPortable(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error('Invalid GLB container');
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  const forbidden = ['EXT_meshopt_compression', 'KHR_draco_mesh_compression', 'KHR_texture_basisu'];
  const extensions = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
  if (extensions.some(name => forbidden.includes(name))) throw new Error('Decoder extension forbidden');
  if ((json.buffers ?? []).some(b => b.uri) || (json.images ?? []).some(i => i.uri))
    throw new Error('Expected self-contained GLB');
  return extensions;
}
assertPortable(source);
const doc = await io.readBinary(source);
async function metrics(document, bytes) {
  let triangles = 0;
  const primitives = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error('Only TRIANGLES input is supported');
      const count = (primitive.getIndices() ?? primitive.getAttribute('POSITION')).getCount();
      if (count % 3) throw new Error('Invalid triangle count');
      triangles += count / 3;
      primitives.push({ mesh: mesh.getName(), triangles: count / 3 });
    }
  }
  const textures = [];
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) throw new Error('Missing embedded texture');
    const meta = await sharp(Buffer.from(image)).metadata();
    textures.push({ name: texture.getName(), width: meta.width, height: meta.height,
      mimeType: texture.getMimeType(), bytes: image.byteLength, sha256: sha(image) });
  }
  return { bytes: bytes.length, sha256: sha(bytes), triangles, primitives, textures };
}
const before = await metrics(doc, source);
await doc.transform(weld(), simplify({
  simplifier: MeshoptSimplifier, ratio: Math.min(1, 20000 / before.triangles),
  error: 0.001, lockBorder: true,
}), prune(), dedup());
// Keep UVs/materials/normals; never flatten, quantize, or add runtime compression.
// PNG preserves alpha and normal/packed maps. JPEG only for opaque color maps.
const colorTextures = new Set(doc.getRoot().listMaterials().flatMap(m =>
  [m.getBaseColorTexture(), m.getEmissiveTexture()].filter(Boolean)));
const dataTextures = new Set(doc.getRoot().listMaterials().flatMap(m =>
  [m.getNormalTexture(), m.getOcclusionTexture(), m.getMetallicRoughnessTexture()].filter(Boolean)));
for (const texture of doc.getRoot().listTextures()) {
  const original = Buffer.from(texture.getImage());
  const meta = await sharp(original).metadata();
  let image = sharp(original).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
  const jpeg = colorTextures.has(texture) && !dataTextures.has(texture) && !meta.hasAlpha;
  image = jpeg ? image.jpeg({ quality: 82, chromaSubsampling: '4:4:4' }) : image.png({ compressionLevel: 9 });
  texture.setImage(await image.toBuffer()).setMimeType(jpeg ? 'image/jpeg' : 'image/png');
}
const encoded = Buffer.from(await io.writeBinary(doc));
const extensions = assertPortable(encoded);
// Measure serialized readback, not only the pre-export document.
const after = await metrics(await io.readBinary(encoded), encoded);
const numericPass = after.bytes < 1000000 && after.triangles >= 16000 && after.triangles <= 24000 &&
  after.textures.length > 0 && after.textures.every(t => t.width <= size && t.height <= size);
const report = { schemaVersion: 1, tools: versions, node: process.version,
  settings: { targetTriangles: 20000, error: 0.001, lockBorder: true, textureMax: size },
  input: { path: 'packages/client/public/whale-assets/humpback-whale-light.glb', ...before },
  output: { path: output.slice(root.length + 1), ...after, extensions },
  numericPass, visualAcceptance: 'pending Instabox: mouth, throat grooves, flippers, flukes and recognizable texture',
  status: numericPass ? 'candidate-needs-visual-review' : 'candidate-outside-budget' };
await mkdir(assets, { recursive: true });
await writeFile(output, encoded, { flag: 'wx' });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!numericPass) process.exitCode = 2;
