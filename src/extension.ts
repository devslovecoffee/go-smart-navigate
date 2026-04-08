import * as vscode from "vscode";

interface PickItem extends vscode.QuickPickItem {
  location?: vscode.Location;
}

// Reentrancy guard: when our provider calls executeDefinitionProvider,
// that would call us again. The flag makes us return undefined on the
// recursive call, so only gopls responds and we get its results cleanly.
let isReentrant = false;

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "goSmartNavigate.go",
    smartNavigate
  );
  context.subscriptions.push(disposable);

  // Register a definition provider so cmd+click picks up implementations.
  // We only return the *extra* implementation locations — gopls handles
  // the definition itself, so there are no duplicates.
  const defProvider = vscode.languages.registerDefinitionProvider(
    { language: "go", scheme: "file" },
    {
      async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ): Promise<vscode.Location[] | undefined> {
        if (isReentrant) {
          return undefined;
        }

        isReentrant = true;
        try {
          const [definitions, implementations] = await Promise.all([
            getDefinitions(document.uri, position),
            getImplementations(document.uri, position),
          ]);

          if (token.isCancellationRequested || definitions.length === 0) {
            return undefined;
          }

          const filteredImpls = filterNoise(
            implementations.filter(
              (impl) => !definitions.some((def) => isSameLocation(def, impl))
            )
          );

          // Only include usages when on the definition
          const cursorLoc = new vscode.Location(document.uri, position);
          const isOnDefinition = definitions.some(
            (def) => isSameLocation(def, cursorLoc)
          );

          let filteredRefs: vscode.Location[] = [];
          if (isOnDefinition) {
            const references = await getReferences(document.uri, position);
            const knownKeys = new Set(
              [...definitions, ...implementations].map(locationKey)
            );
            filteredRefs = filterNoise(
              references.filter((ref) => !knownKeys.has(locationKey(ref)))
            );
          }

          const extras = [...filteredImpls, ...filteredRefs];

          if (
            extras.length > 0 &&
            (await isInterfaceLocation(definitions[0]))
          ) {
            return extras;
          }

          return undefined;
        } finally {
          isReentrant = false;
        }
      },
    }
  );
  context.subscriptions.push(defProvider);
}

async function smartNavigate(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;

  // Check that the Go extension is present
  const goExt = vscode.extensions.getExtension("golang.go");
  if (!goExt) {
    vscode.window.showWarningMessage(
      "Go Smart Navigate: The Go extension (golang.go) is not installed. Falling back to default definition."
    );
    await vscode.commands.executeCommand("editor.action.revealDefinition");
    return;
  }

  const statusItem = vscode.window.setStatusBarMessage(
    "$(loading~spin) Finding implementations..."
  );

  try {
    const [definitions, implementations] = await Promise.all([
      getDefinitions(document.uri, position),
      getImplementations(document.uri, position),
    ]);

    statusItem.dispose();

    if (definitions.length === 0) {
      vscode.window.showInformationMessage("No definition found.");
      return;
    }

    const allLocations = deduplicateLocations([
      ...definitions,
      ...implementations,
    ]);
    const filteredImpls = filterNoise(
      implementations.filter(
        (impl) =>
          !definitions.some((def) => isSameLocation(def, impl))
      )
    );

    // Only fetch and show usages when inspecting the definition itself
    const cursorLoc = new vscode.Location(document.uri, position);
    const isOnDefinition = definitions.some(
      (def) => isSameLocation(def, cursorLoc)
    );

    let filteredRefs: vscode.Location[] = [];
    if (isOnDefinition) {
      const references = await getReferences(document.uri, position);
      const knownKeys = new Set(
        [...definitions, ...implementations].map(locationKey)
      );
      filteredRefs = filterNoise(
        references.filter((ref) => !knownKeys.has(locationKey(ref)))
      );
    }

    if (filteredImpls.length === 0 && filteredRefs.length === 0) {
      // No extra implementations or usages — jump directly to definition
      await jumpDirect(definitions[0]);
      return;
    }

    // Check if the definition is on an interface method
    const defIsInterface = await isInterfaceLocation(definitions[0]);

    if (!defIsInterface && filteredRefs.length === 0) {
      // Concrete symbol with no usages — just jump
      if (allLocations.length === 1) {
        await jumpDirect(allLocations[0]);
        return;
      }
    }

    // Multiple meaningful locations — show picker
    await showPicker(definitions, filteredImpls, filteredRefs);
  } catch (err) {
    statusItem.dispose();
    // Fallback to standard definition jump on any error
    await vscode.commands.executeCommand("editor.action.revealDefinition");
  }
}

async function getDefinitions(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[]
  >("vscode.executeDefinitionProvider", uri, position);

  if (!result) {
    return [];
  }
  return normalizeLocations(result);
}

async function getImplementations(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[]
  >("vscode.executeImplementationProvider", uri, position);

  if (!result) {
    return [];
  }
  return normalizeLocations(result);
}

async function getReferences(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    position
  );

  if (!result) {
    return [];
  }
  return result;
}

function normalizeLocations(
  results: vscode.Location[] | vscode.LocationLink[]
): vscode.Location[] {
  return results.map((r) => {
    if (r instanceof vscode.Location) {
      return r;
    }
    // LocationLink
    const link = r as vscode.LocationLink;
    return new vscode.Location(link.targetUri, link.targetRange);
  });
}

function locationKey(loc: vscode.Location): string {
  return `${loc.uri.toString()}:${loc.range.start.line}`;
}

function isSameLocation(a: vscode.Location, b: vscode.Location): boolean {
  return locationKey(a) === locationKey(b);
}

function deduplicateLocations(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  const unique: vscode.Location[] = [];
  for (const loc of locations) {
    const key = locationKey(loc);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(loc);
    }
  }
  return unique;
}

function filterNoise(locations: vscode.Location[]): vscode.Location[] {
  return locations.filter((loc) => {
    const path = loc.uri.path;
    if (path.includes("/vendor/")) {
      return false;
    }
    if (path.endsWith(".pb.go")) {
      return false;
    }
    return true;
  });
}

async function isInterfaceLocation(loc: vscode.Location): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const targetLine = loc.range.start.line;
    const startLine = Math.max(0, targetLine - 5);

    for (let i = targetLine; i >= startLine; i--) {
      const lineText = doc.lineAt(i).text;
      if (/type\s+\w+\s+interface\s*\{/.test(lineText)) {
        return true;
      }
      // Stop searching if we hit a closing brace (left the block)
      if (lineText.trim() === "}") {
        return false;
      }
    }
  } catch {
    // If we can't read the file, assume not an interface
  }
  return false;
}

async function jumpDirect(location: vscode.Location): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = location.range.start;
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
}

function relativePath(uri: vscode.Uri): string {
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (wsFolder) {
    return uri.fsPath.replace(wsFolder.uri.fsPath + "/", "");
  }
  return uri.fsPath;
}

async function getLinePreview(loc: vscode.Location): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    return doc.lineAt(loc.range.start.line).text.trim();
  } catch {
    return "";
  }
}

async function showPicker(
  definitions: vscode.Location[],
  implementations: vscode.Location[],
  usages: vscode.Location[]
): Promise<void> {
  const allLocs = [...definitions, ...implementations, ...usages];
  const previews = await Promise.all(allLocs.map(getLinePreview));

  const items: PickItem[] = [];
  let idx = 0;

  items.push({
    label: "Definition",
    kind: vscode.QuickPickItemKind.Separator,
  });
  for (const def of definitions) {
    items.push({
      label: `$(symbol-interface) ${previews[idx]}`,
      detail: `${relativePath(def.uri)}:${def.range.start.line + 1}`,
      location: def,
    });
    idx++;
  }

  if (implementations.length > 0) {
    items.push({
      label: "Implementations",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const impl of implementations) {
      items.push({
        label: `$(symbol-method) ${previews[idx]}`,
        detail: `${relativePath(impl.uri)}:${impl.range.start.line + 1}`,
        location: impl,
      });
      idx++;
    }
  }

  if (usages.length > 0) {
    items.push({
      label: "Usages",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const usage of usages) {
      items.push({
        label: `$(references) ${previews[idx]}`,
        detail: `${relativePath(usage.uri)}:${usage.range.start.line + 1}`,
        location: usage,
      });
      idx++;
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select destination",
  });

  if (selected?.location) {
    await jumpDirect(selected.location);
  }
}

export function deactivate() {}
