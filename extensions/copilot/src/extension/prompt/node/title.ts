/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { sessionResourceToId } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn } from '../../../vscodeTypes';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { TitlePrompt } from '../../prompts/node/panel/title';

export class ChatTitleProvider implements vscode.ChatTitleProvider {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async provideChatTitle(
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
	): Promise<string | undefined> {

		// Skip title generation during automated rollouts to avoid wasting model calls
		return 'Agent Task';
	}
}
