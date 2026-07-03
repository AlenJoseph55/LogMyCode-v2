import * as vscode from "vscode";
import { DailySummaryWebview } from "./DailySummaryWebview.js";

/**
 * Called when the extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("LogMyCode extension is now active!");

  // Register command to display the dashboard panel
  const showDashboardCommand = vscode.commands.registerCommand(
    "logmycode.showDashboard",
    () => {
      DailySummaryWebview.createOrShow(context);
    }
  );

  context.subscriptions.push(showDashboardCommand);
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {
  console.log("LogMyCode extension is deactivated.");
}
