import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Copy only declarations reachable from the public plugin surface, never a
 * workspace runtime or an entire barrel's unrelated schema dependencies. */
export function closePublicTypes(packageRoot) {
  const output = resolve(packageRoot, "dist");
  const localFiles = readdirSync(output).filter((name) => name.endsWith(".d.ts")).map((name) => resolve(output, name));
  const program = ts.createProgram(localFiles, {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const selected = new Map();
  const imports = new Map();
  const workspaceRoots = ["host", "core", "config"].map((name) => ({
    source: resolve(packageRoot, "..", name, "dist"), destination: resolve(output, "types", name),
  }));
  const localSet = new Set(localFiles);
  function destination(file) {
    file = resolve(file);
    if (localSet.has(file)) return file;
    const match = workspaceRoots.find((root) => file.startsWith(root.source + sep));
    if (match === undefined) return undefined;
    return resolve(match.destination, relative(match.source, file));
  }
  function add(node) {
    const source = node.getSourceFile();
    const file = resolve(source.fileName);
    if (destination(source.fileName) === undefined || ts.isSourceFile(node)) return;
    let statement = node;
    while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
    if (ts.isImportDeclaration(statement)) return;
    const nodes = selected.get(file) ?? new Set();
    selected.set(file, nodes);
    if (nodes.has(statement)) return;
    nodes.add(statement);
    visit(statement);
  }
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isExportSpecifier(node.parent)
        ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol) {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          const alias = checker.getAliasedSymbol(symbol);
          const declaration = symbol.declarations?.[0];
          if (declaration && ts.isImportSpecifier(declaration)) {
            const file = resolve(declaration.getSourceFile().fileName);
            const entries = imports.get(file) ?? new Map();
            entries.set(declaration, alias);
            imports.set(file, entries);
          }
          for (const declaration of alias.declarations ?? []) add(declaration);
        } else {
          for (const declaration of symbol.declarations ?? []) add(declaration);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  // Existing plugin declarations keep their full public surface. Workspace
  // dependencies are selected by referenced symbols, with aliases resolved.
  for (const file of localFiles) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`DSH_FUSION_DECLARATION_MISSING:${file}`);
    for (const statement of source.statements) if (!ts.isImportDeclaration(statement)) add(statement);
  }
  const slash = (path) => path.split(sep).join("/");
  for (const [file, nodes] of selected) {
    const target = destination(file);
    const source = program.getSourceFile(file);
    const lines = [];
    const groups = new Map();
    for (const [specifier, symbol] of imports.get(file) ?? []) {
      const declaration = specifier.parent.parent.parent;
      const originalModule = declaration.moduleSpecifier.text;
      const originalType = declaration.importClause.isTypeOnly;
      const definition = symbol.declarations?.[0];
      const ownTarget = definition && destination(definition.getSourceFile().fileName);
      let module = originalModule;
      if (ownTarget) {
        module = slash(relative(dirname(target), ownTarget)).replace(/\.d\.ts$/, ".js");
        if (!module.startsWith(".")) module = `./${module}`;
      } else if (module.startsWith("@dsh-fusion/")) {
        throw new Error(`DSH_FUSION_UNRESOLVED_PUBLIC_TYPE:${module}`);
      }
      const key = JSON.stringify([module, originalType]);
      const group = groups.get(key) ?? [];
      const imported = ownTarget ? symbol.name : (specifier.propertyName?.text ?? specifier.name.text);
      group.push(imported === specifier.name.text ? imported : `${imported} as ${specifier.name.text}`);
      groups.set(key, group);
    }
    // Preserve default/namespace imports (currently React's declaration is named).
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && (!statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings))) {
        lines.push(statement.getText(source));
      }
    }
    for (const [key, names] of groups) {
      const [module, type] = JSON.parse(key);
      lines.push(`import ${type ? "type " : ""}{ ${[...new Set(names)].join(", ")} } from ${JSON.stringify(module)};`);
    }
    lines.push(...source.statements.filter((node) => nodes.has(node)).map((node) => node.getText(source)));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, lines.join("\n") + "\n");
  }
  return [...selected.keys()].filter((file) => !localSet.has(file)).length;
}
