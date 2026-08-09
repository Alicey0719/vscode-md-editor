import * as vscode from 'vscode';
import { MdEditorProvider } from './editorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MdEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MdEditorProvider.viewType, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mdEditor.openHere', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('No file selected.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, MdEditorProvider.viewType);
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
