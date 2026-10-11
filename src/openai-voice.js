const API_URL = 'https://api.openai.com/v1/responses';
const MAX_TOOL_ROUNDS = 4;

const systemInstructions = `You are the voice receptionist for Nocona Hills Repair & Replace in Nocona Hills, Texas.
Be warm, concise, and easy to understand over the phone. Never claim to be human. Do not send or offer SMS.
You can answer general questions about the business only when supported by this prompt. Do not invent prices,
service guarantees, hours, or policies. The service area is limited to the mapped Nocona Hills residential
neighborhood in Texas ZIP 76255. Ask one question at a time. To book a visit, collect the caller's name,
requested service, full street address, and issue description, then call save_service_request. Only offer a
visit after that tool confirms the address is in the service area. Call get_available_slots to check the
calendar; offer only returned choices and ask the caller to select one. Call prepare_booking to stage the
selected time, then ask the caller to clearly say yes or no.
The server books only after it independently receives a clear yes. Never say a visit is booked before the
server confirms success. If the address is outside the service area, politely explain that no visit can be
booked. If there may be immediate danger, tell the caller to call 911 now. If a tool fails, be transparent
and do not claim success.`;

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
  {
    type: 'function',
    name: 'get_available_slots',
    description: 'Find appointment options after the service request has been validated.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'prepare_booking',
    description: 'Stage an offered appointment time and ask for the caller’s explicit yes/no confirmation. This does not book the visit.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { choice: { type: 'integer', enum: [1, 2, 3] } },
      required: ['choice'],
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

async function requestResponse(input, fetchImpl) {
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
      instructions: systemInstructions,
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

async function generateReply(history, callerText, executeTool, fetchImpl = global.fetch) {
  if (typeof callerText !== 'string' || !callerText.trim() || callerText.length > 2000) {
    throw new Error('Caller utterance is empty or too long.');
  }

  const userTurn = { role: 'user', content: callerText.trim() };
  let input = [...history, userTurn];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await requestResponse(input, fetchImpl);
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
