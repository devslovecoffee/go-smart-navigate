import * as vscode from "vscode";

interface PickItem extends vscode.QuickPickItem {
  location?: vscode.Location;
}

interface ResolvedLocations {
  definitions: vscode.Location[];
  implementations: vscode.Location[];
  references: vscode.Location[];
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
          const { definitions, implementations, references } =
            await resolveLocations(document.uri, position);

          if (token.isCancellationRequested || definitions.length === 0) {
            return undefined;
          }

          const extras = [...implementations, ...references];

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

async function resolveLocations(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<ResolvedLocations> {
  const [definitions, rawImplementations] = await Promise.all([
    getDefinitions(uri, position),
    getImplementations(uri, position),
  ]);

  const implementations = filterNoise(
    rawImplementations.filter(
      (impl) => !definitions.some((def) => isSameLocation(def, impl))
    )
  );

  const cursorLoc = new vscode.Location(uri, position);
  const isOnDefinition = definitions.some((def) =>
    isSameLocation(def, cursorLoc)
  );

  let references: vscode.Location[] = [];
  if (isOnDefinition) {
    const rawReferences = await getReferences(uri, position);
    const knownKeys = new Set(
      [...definitions, ...rawImplementations].map(locationKey)
    );
    references = filterNoise(
      rawReferences.filter((ref) => !knownKeys.has(locationKey(ref)))
    );
  }

  return { definitions, implementations, references };
}

async function smartNavigate(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;

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
    const { definitions, implementations, references } =
      await resolveLocations(document.uri, position);

    if (definitions.length === 0) {
      vscode.window.showInformationMessage("No definition found.");
      return;
    }

    if (implementations.length === 0 && references.length === 0) {
      await jumpDirect(definitions[0]);
      return;
    }

    await showPicker(definitions, implementations, references);
  } catch (err) {
    console.error("Smart Navigate error:", err);
    await vscode.commands.executeCommand("editor.action.revealDefinition");
  } finally {
    statusItem.dispose();
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
    const link = r as vscode.LocationLink;
    return new vscode.Location(link.targetUri, link.targetRange);
  });
}

function locationKey(loc: vscode.Location): string {
  return `${loc.uri.toString()}:${loc.range.start.line}:${loc.range.start.character}`;
}

function isSameLocation(a: vscode.Location, b: vscode.Location): boolean {
  return locationKey(a) === locationKey(b);
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

    for (let i = targetLine; i >= 0; i--) {
      const lineText = doc.lineAt(i).text;
      if (/type\s+\w+\s+interface\s*\{/.test(lineText)) {
        return true;
      }
      if (lineText.trim() === "}") {
        return false;
      }
    }
  } catch (err) {
    console.error("Smart Navigate: failed to check interface location:", err);
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
  return vscode.workspace.asRelativePath(uri);
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
  const previewMap = new Map(allLocs.map((loc, i) => [loc, previews[i]]));

  const items: PickItem[] = [];

  items.push({
    label: "Definition",
    kind: vscode.QuickPickItemKind.Separator,
  });
  for (const def of definitions) {
    items.push({
      label: `$(symbol-interface) ${previewMap.get(def)}`,
      detail: `${relativePath(def.uri)}:${def.range.start.line + 1}`,
      location: def,
    });
  }

  if (implementations.length > 0) {
    items.push({
      label: "Implementations",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const impl of implementations) {
      items.push({
        label: `$(symbol-method) ${previewMap.get(impl)}`,
        detail: `${relativePath(impl.uri)}:${impl.range.start.line + 1}`,
        location: impl,
      });
    }
  }

  if (usages.length > 0) {
    items.push({
      label: "Usages",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const usage of usages) {
      items.push({
        label: `$(references) ${previewMap.get(usage)}`,
        detail: `${relativePath(usage.uri)}:${usage.range.start.line + 1}`,
        location: usage,
      });
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
