/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { lm, type CancellationToken, type ChatRequest, type ChatResponseStream, type LanguageModelToolInformation, type Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { BuilderSubagentPrompt } from '../../prompts/node/agent/builderSubagentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface IBuilderSubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
	/** Optional pre-generated subagent invocation ID. If not provided, a new UUID will be generated. */
	subAgentInvocationId?: string;
	/** The tool_call_id from the parent agent's LLM response that triggered this subagent invocation. */
	parentToolCallId?: string;
}

export class BuilderSubagentToolCallingLoop extends ToolCallingLoop<IBuilderSubagentToolCallingLoopOptions> {

	public static readonly ID = 'builderSubagentTool';

	constructor(
		options: IBuilderSubagentToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IToolsService private readonly toolsService: IToolsService,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IChatHookService chatHookService: IChatHookService,
		@ISessionTranscriptService sessionTranscriptService: ISessionTranscriptService,
		@IFileSystemService fileSystemService: IFileSystemService,
		@IOTelService otelService: IOTelService,
		@IGitService gitService: IGitService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService, chatHookService, sessionTranscriptService, fileSystemService, otelService, gitService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				subAgentInvocationId: this.options.subAgentInvocationId ?? randomUUID(),
				subAgentName: 'builder'
			};
		}
		context.query = this.options.promptText;
		return context;
	}

	/**
	 * Get the endpoint to use for the builder subagent — currently uses the main agent model
	 * (mirrors search/execution subagents). The customoai vendor lookup below is preserved
	 * (commented out) for the case where the builder should run on a separately configured model.
	 */
	private async getEndpoint() {
		return await this.endpointProvider.getChatEndpoint(this.options.request);
		// const model_name = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.BuilderSubagentModel, this._experimentationService);
		// const models = await lm.selectChatModels({ vendor: 'customoai', id: model_name });
		// if (models.length === 0) {
		// 	throw new Error(`Builder subagent model ${model_name} not found`);
		// }
		// return await this.endpointProvider.getChatEndpoint(models[0]);
	}

	protected async buildPrompt(buildpromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint();
		const maxBuilderTurns = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.BuilderSubagentToolCallLimit, this._experimentationService);
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			BuilderSubagentPrompt,
			{
				promptContext: buildpromptContext,
				maxBuilderTurns
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		// NOTE: We intentionally do NOT use `toolsService.getEnabledTools(request, endpoint)` here.
		// That call consults the parent ChatRequest's tool-picker map and excludes any tool
		// whose contributed name isn't explicitly set to `true` there. The four edit tools
		// (insert_edit_into_file, replace_string_in_file, multi_replace_string_in_file,
		// apply_patch) are represented in the picker collectively by `copilot_editFiles`
		// (EditFilesPlaceholder); their individual contributed names are never populated as
		// `true`, so they get stripped before our whitelist filter runs. Bypassing the picker
		// by reading the registered tool list directly guarantees the builder sees every
		// whitelisted tool. Downside: we lose the per-model `alternativeDefinition` / model-
		// specific override rewrites that `getEnabledTools` applies in its `.map()` step
		// (toolsService.ts:290-310). Acceptable for the builder for now.

		// Mirrors the main agent's ALLOWED_TOOL_NAMES (agentIntent.ts) minus runSubagent (no recursion)
		// and minus builder_subagent itself (no self-recursion).
		// All edit tools are included unconditionally — no per-model `modelSupports*` gating.
		const allowedBuilderTools = new Set<string>([
			ToolName.ReadFile,                // read_file
			ToolName.CoreRunInTerminal,       // run_in_terminal
			ToolName.CoreManageTodoList,      // manage_todo_list (central to workflow)
			ToolName.ReplaceString,           // replace_string_in_file
			ToolName.FindTextInFiles,         // grep_search
			ToolName.CoreGetTerminalOutput,   // get_terminal_output
			ToolName.MultiReplaceString,      // multi_replace_string_in_file
			ToolName.CreateFile,              // create_file
			ToolName.GetErrors,               // get_errors
			ToolName.FindFiles,               // file_search
			ToolName.ListDirectory,           // list_dir
			ToolName.FetchWebPage,            // fetch_webpage
			ToolName.Memory,                  // memory
			ToolName.Codebase,                // semantic_search
			ToolName.CoreTerminalLastCommand, // terminal_last_command
			ToolName.CoreTerminalSelection,   // terminal_selection
			ToolName.EditFile,                // insert_edit_into_file
			ToolName.ApplyPatch,              // apply_patch
			ToolName.SearchSubagent,          // search_subagent
			ToolName.ExecutionSubagent,       // execution_subagent
		]);

		return this.toolsService.tools.filter(tool => allowedBuilderTools.has(tool.name));
	}

	protected async fetch({ messages, finishedCb, requestOptions, modelCapabilities }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint();
		return endpoint.makeChatRequest2({
			debugName: BuilderSubagentToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			modelCapabilities: { ...modelCapabilities, reasoningEffort: undefined },
			requestOptions: {
				...(requestOptions ?? {}),
				temperature: 0
			},
			// This loop is inside a tool called from another request, so never user initiated
			userInitiatedRequest: false,
			telemetryProperties: {
				requestId: this.options.subAgentInvocationId,
				messageId: randomUUID(),
				messageSource: 'chat.editAgent',
				subType: 'subagent/builder',
				conversationId: this.options.conversation.sessionId,
				parentToolCallId: this.options.parentToolCallId,
			},
		}, token);
	}
}
