import type { AgentMessage, MessagePart } from './types.js';

export function normalizeInputMessage(params: {
  prompt?: string;
  inputMessage?: AgentMessage;
}): AgentMessage {
  if (params.inputMessage) {
    return params.inputMessage;
  }
  const prompt = params.prompt?.trim();
  if (!prompt) {
    throw new Error('Either prompt or input_message is required');
  }
  return {
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
  };
}

export function agentMessageToPrompt(message: AgentMessage): string {
  return message.parts.map(renderMessagePartForPrompt).filter(Boolean).join('\n\n').trim();
}

export function summarizeMessageParts(parts: MessagePart[]): string | null {
  const text = parts.map(renderMessagePartForPrompt).filter(Boolean).join('\n\n').trim();
  return text || null;
}

function renderMessagePartForPrompt(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'data':
      return JSON.stringify(part.data, null, 2);
    case 'file':
      if (part.uri) {
        return `Attached file: ${part.name ?? part.uri}`;
      }
      if (part.name) {
        return `Attached file bytes: ${part.name}`;
      }
      return 'Attached file bytes';
  }
}
