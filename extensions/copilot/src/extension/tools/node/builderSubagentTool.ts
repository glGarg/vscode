/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseNotebookEditPart, ChatResponseTextEditPart, ChatToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { BuilderSubagentToolCallingLoop } from '../../prompt/node/builderSubagentToolCallingLoop';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IBuilderSubagentParams {

	/** The task description or full plan text for the builder to execute end-to-end. */
	query: string;
	/** User-visible description shown while invoking */
	description: string;
}

class BuilderSubagentTool implements ICopilotTool<IBuilderSubagentParams> {
	public static readonly toolName = ToolName.BuilderSubagent;
	public static readonly nonDeferred = true;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * If a `plan.md` file exists at the workspace root, read it and return its contents.
	 * Used to inject the full plan text into the builder subagent's prompt regardless of
	 * what the main agent put in the tool-call arguments. Returns `undefined` on any failure.
	 */
	private async _tryReadWorkspacePlanMd(): Promise<string | undefined> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}
		const planUri = vscode.Uri.joinPath(folders[0].uri, 'plan.md');
		try {
			const bytes = await vscode.workspace.fs.readFile(planUri);
			const text = new TextDecoder('utf-8').decode(bytes).trim();
			return text.length > 0 ? text : undefined;
		} catch (err) {
			this.logService.debug(`BuilderSubagentTool: no plan.md at ${planUri.fsPath} (${err})`);
			return undefined;
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IBuilderSubagentParams>, token: vscode.CancellationToken) {
		const planFromFile = await this._tryReadWorkspacePlanMd();
		const effectiveQuery = planFromFile ?? options.input.query;

		const builderInstruction = [
			'Task / Plan:',
			`${effectiveQuery}`,
			'',
		].join('\n');

		if (!this._inputContext) {
			throw new Error('BuilderSubagentTool: _inputContext is not set. Ensure resolveInput is called before invoke.');
		}

		const request = this._inputContext.request!;
		const parentSessionId = this._inputContext.conversation?.sessionId ?? generateUuid();
		// Generate a stable session ID for this subagent invocation that will be used:
		// 1. As subAgentInvocationId in the subagent's tool context
		// 2. As subAgentInvocationId in toolMetadata for parent trajectory linking
		// 3. As the session_id in the subagent's own trajectory
		const subAgentInvocationId = generateUuid();

		const toolCallLimit = this.configurationService.getExperimentBasedConfig(ConfigKey.Advanced.BuilderSubagentToolCallLimit, this.experimentationService);

		const loop = this.instantiationService.createInstance(BuilderSubagentToolCallingLoop, {
			toolCallLimit,
			conversation: new Conversation(parentSessionId, [new Turn(generateUuid(), { type: 'user', message: builderInstruction })]),
			request: request,
			location: request.location,
			promptText: effectiveQuery,
			subAgentInvocationId: subAgentInvocationId,
			parentToolCallId: options.chatStreamToolCallId,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a new capturing token to group this builder subagent and all its nested tool calls.
		// Pass the subAgentInvocationId so the trajectory uses this ID for explicit linking.
		const builderSubagentToken = new CapturingToken(
			`Builder: ${effectiveQuery.substring(0, 50)}${effectiveQuery.length > 50 ? '...' : ''}`,
			'builder',
			subAgentInvocationId,
			'builder'  // subAgentName for trajectory tracking
		);

		// Wrap the loop execution in captureInvocation with the new token
		// All nested tool calls will now be logged under this same CapturingToken
		const loopResult = await this.requestLogger.captureInvocation(builderSubagentToken, () => loop.run(stream, token));

		// Build subagent trajectory metadata that will be logged via toolMetadata
		// All nested tool calls are already logged by ToolCallingLoop.logToolResult()
		const toolMetadata = {
			query: options.input.query,
			description: options.input.description,
			// The subAgentInvocationId links this tool call to the subagent's trajectory
			subAgentInvocationId: subAgentInvocationId,
			agentName: 'builder'
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The builder subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		// toolMetadata will be automatically included in exportAllPromptLogsAsJsonCommand
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		result.toolResultMessage = new MarkdownString(l10n.t`Build complete: ${options.input.description}`);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IBuilderSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: IBuilderSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IBuilderSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(BuilderSubagentTool);
