const { buildInstructions } = require('./agent-profile');

const API_URL = 'https://api.openai.com/v1/responses';
const MAX_TOOL_ROUNDS = 4;

// Used only when a caller's profile is unavailable; each call normally passes its own instructions.
const systemInstructions = buildInstructions({});

const tools = [
  {
    type: 'function',
    name: 'save_service_request',
    description: 'Validate and save the caller details required for an appointment.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        service_type: { type: 'string' },
        service_address: { type: 'string' },
        issue_description: { type: 'string' },
      },
      required: ['customer_name', 'service_type', 'service_address', 'issue_description'],
      additionalProperties: false,
    },
  },
];

function responseText(response) {
  if (typeof response.output_text === 'string') return response.output_text.trim();
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join(' ').trim();
}

async function requestResponse(input, fetchImpl, instructions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI voice service is not configured.');
  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions: instructions || systemInstructions,
      input,
      tools,
      store: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI voice request failed with status ${response.status}.`);
  return data;
}

async function generateReply(history, callerText, executeTool, fetchImpl = global.fetch, options = {}) {
  if (typeof callerText !== 'string' || !callerText.trim() || callerText.length > 2000) {
    throw new Error('Caller utterance is empty or too long.');
  }

  const userTurn = { role: 'user', content: callerText.trim() };
  let input = [...history, userTurn];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await requestResponse(input, fetchImpl, options.instructions);
    const output = Array.isArray(response.output) ? response.output : [];
    const calls = output.filter((item) => item.type === 'function_call');
    if (!calls.length) {
      const text = responseText(response);
      if (!text) throw new Error('OpenAI returned no spoken response.');
      history.push(userTurn, { role: 'assistant', content: text });
      if (history.length > 40) history.splice(0, history.length - 40);
      return text.slice(0, 1500);
    }

    input = [...input, ...output];
    for (const call of calls) {
      let result;
      try {
        const args = JSON.parse(call.arguments);
        result = await executeTool(call.name, args);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('OpenAI returned invalid tool arguments.');
        throw error;
      }
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }
  throw new Error('OpenAI exceeded the allowed tool-call rounds.');
}

module.exports = { generateReply, responseText, systemInstructions, tools };
