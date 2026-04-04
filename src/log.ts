import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function init(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("SOPS Edit");
  return channel;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function info(message: string): void {
  channel?.appendLine(`[${timestamp()}] INFO: ${message}`);
}

export function warn(message: string): void {
  channel?.appendLine(`[${timestamp()}] WARN: ${message}`);
}

export function error(message: string): void {
  channel?.appendLine(`[${timestamp()}] ERROR: ${message}`);
}

export function show(): void {
  channel?.show();
}
