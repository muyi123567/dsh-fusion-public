import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chunks = ['client.js', 'client.workspace.js', 'client.native-ocean.js', 'client.ocean-scene.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read only. Bind the installed four chunks to the exact supplied npm tarball. */
export async function verifyInstalledNativeArtifacts({ packagePath, installedDist, expectedSha256 }) {
  assert(packagePath && installedDist && expectedSha256, 'Package, installed dist and expected SHA-256 required');
  const packed = await readFile(packagePath);
  const artifactSha256 = sha(packed);
  assert.equal(artifactSha256, expectedSha256, 'Candidate tarball SHA-256 differs');
  const tar = gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 });
  const packaged = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(text(124, 136).trim() || '0', 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar member size');
    const member = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    const name = chunks.find(name => member === 'package/dist/' + name || member === './package/dist/' + name);
    if (name && (header[156] === 0 || header[156] === 48)) {
      assert(!packaged.has(name), 'Duplicate native chunk in candidate package: ' + name);
      packaged.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(packaged.size, chunks.length, 'Candidate package must contain all four native chunks');
  const bindings = [];
  for (const name of chunks) {
    const expected = packaged.get(name), installed = await readFile(join(installedDist, name));
    assert(installed.equals(expected), 'Installed bytes differ from exact tarball: ' + name);
    bindings.push({ name, bytes: installed.length, sha256: sha(installed), exactBytesEqual: true });
  }
  return { artifactSha256, bindings, installedFilesModified: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], '--installed', 'Use --installed or import the verification function');
  const result = await verifyInstalledNativeArtifacts({ packagePath: process.env.WHALE_QA_TGZ,
    installedDist: process.env.WHALE_QA_INSTALLED_DIST, expectedSha256: process.env.WHALE_QA_ARTIFACT_SHA256 });
  console.log('NATIVE_ARTIFACT_BINDING', JSON.stringify(result));
}
