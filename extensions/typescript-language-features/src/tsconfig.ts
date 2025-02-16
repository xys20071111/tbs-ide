/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as Proto from './tsServer/protocol/protocol';
import { ITypeScriptServiceClient, ServerResponse } from './typescriptService';
import { nulToken } from './utils/cancellation';
import { TypeScriptServiceConfiguration } from './configuration/configuration';


export const enum ProjectType {
	TypeScript,
	JavaScript,
}

export function isImplicitProjectConfigFile(configFileName: string) {
	return configFileName.startsWith('/dev/null/');
}

const defaultProjectConfig = Object.freeze<Proto.ExternalProjectCompilerOptions>({
	module: 'ESNext' as Proto.ModuleKind,
	moduleResolution: 'Node' as Proto.ModuleResolutionKind,
	target: 'ES2020' as Proto.ScriptTarget,
	jsx: 'react' as Proto.JsxEmit,
});

export function inferredProjectCompilerOptions(
	projectType: ProjectType,
	serviceConfig: TypeScriptServiceConfiguration,
): Proto.ExternalProjectCompilerOptions {
	const projectConfig = { ...defaultProjectConfig };

	if (serviceConfig.implicitProjectConfiguration.checkJs) {
		projectConfig.checkJs = true;
		if (projectType === ProjectType.TypeScript) {
			projectConfig.allowJs = true;
		}
	}

	if (serviceConfig.implicitProjectConfiguration.experimentalDecorators) {
		projectConfig.experimentalDecorators = true;
	}

	if (serviceConfig.implicitProjectConfiguration.strictNullChecks) {
		projectConfig.strictNullChecks = true;
	}

	if (serviceConfig.implicitProjectConfiguration.strictFunctionTypes) {
		projectConfig.strictFunctionTypes = true;
	}


	if (serviceConfig.implicitProjectConfiguration.module) {
		projectConfig.module = serviceConfig.implicitProjectConfiguration.module as Proto.ModuleKind;
	}

	if (serviceConfig.implicitProjectConfiguration.target) {
		projectConfig.target = serviceConfig.implicitProjectConfiguration.target as Proto.ScriptTarget;
	}

	if (projectType === ProjectType.TypeScript) {
		projectConfig.sourceMap = true;
	}

	return projectConfig;
}

function inferredProjectConfigSnippet(
	projectType: ProjectType,
	config: TypeScriptServiceConfiguration
) {
	const baseConfig = inferredProjectCompilerOptions(projectType, config);
	const compilerOptions = Object.keys(baseConfig).map(key => `"${key}": ${JSON.stringify(baseConfig[key])}`);
	return new vscode.SnippetString(`{
	"compilerOptions": {
		${compilerOptions.join(',\n\t\t')}$0
	},
	"exclude": [
		"node_modules",
		"**/node_modules/*"
	]
}`);
}

export async function openOrCreateConfig(
	projectType: ProjectType,
	rootPath: vscode.Uri,
	configuration: TypeScriptServiceConfiguration,
): Promise<vscode.TextEditor | null> {
	const configFile = vscode.Uri.joinPath(rootPath, projectType === ProjectType.TypeScript ? 'tsconfig.json' : 'jsconfig.json');
	const col = vscode.window.activeTextEditor?.viewColumn;
	try {
		const doc = await vscode.workspace.openTextDocument(configFile);
		return vscode.window.showTextDocument(doc, col);
	} catch {
		const doc = await vscode.workspace.openTextDocument(configFile.with({ scheme: 'untitled' }));
		const editor = await vscode.window.showTextDocument(doc, col);
		if (editor.document.getText().length === 0) {
			await editor.insertSnippet(inferredProjectConfigSnippet(projectType, configuration));
		}
		return editor;
	}
}

export async function openProjectConfigOrPromptToCreate(
	projectType: ProjectType,
	client: ITypeScriptServiceClient,
	rootPath: vscode.Uri,
	configFilePath: string,
): Promise<void> {
	if (!isImplicitProjectConfigFile(configFilePath)) {
		const doc = await vscode.workspace.openTextDocument(client.toResource(configFilePath));
		vscode.window.showTextDocument(doc, vscode.window.activeTextEditor?.viewColumn);
		return;
	}

	const CreateConfigItem: vscode.MessageItem = {
		title: projectType === ProjectType.TypeScript
			? vscode.l10n.t("Configure tsconfig.json")
			: vscode.l10n.t("Configure jsconfig.json"),
	};

	const selected = await vscode.window.showInformationMessage(
		(projectType === ProjectType.TypeScript
			? vscode.l10n.t("File is not part of a TypeScript project. View the [tsconfig.json documentation]({0}) to learn more.", 'https://go.microsoft.com/fwlink/?linkid=841896')
			: vscode.l10n.t("File is not part of a JavaScript project. View the [jsconfig.json documentation]({0}) to learn more.", 'https://go.microsoft.com/fwlink/?linkid=759670')
		),
		CreateConfigItem);

	switch (selected) {
		case CreateConfigItem:
			openOrCreateConfig(projectType, rootPath, client.configuration);
			return;
	}
}

export async function openProjectConfigForFile(
	projectType: ProjectType,
	client: ITypeScriptServiceClient,
	resource: vscode.Uri,
): Promise<void> {
	const rootPath = client.getWorkspaceRootForResource(resource);
	if (!rootPath) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Please open a folder in TBS-IDE to use a TypeScript or JavaScript project"));
		return;
	}

	const file = client.toTsFilePath(resource);
	// TSServer errors when 'projectInfo' is invoked on a non js/ts file
	if (!file || !client.toTsFilePath(resource)) {
		vscode.window.showWarningMessage(
			vscode.l10n.t("Could not determine TypeScript or JavaScript project. Unsupported file type"));
		return;
	}

	let res: ServerResponse.Response<Proto.ProjectInfoResponse> | undefined;
	try {
		res = await client.execute('projectInfo', { file, needFileNameList: false }, nulToken);
	} catch {
		// noop
	}

	if (res?.type !== 'response' || !res.body) {
		vscode.window.showWarningMessage(vscode.l10n.t("Could not determine TypeScript or JavaScript project"));
		return;
	}
	return openProjectConfigOrPromptToCreate(projectType, client, rootPath, res.body.configFileName);
}

