// LizBot — Netlify serverless function
// Receives a user message, searches relevant content via Supabase pgvector,
// and returns a Claude-powered response in Liz's voice.

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// —— Configuration (set these in Netlify Environment Variables) ——
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// —— System prompt: Liz's voice and persona ——
const SYSTEM_PROMPT = `You are LizBot, an AI assistant representing the knowledge and perspective of Liz Kelly Nelson, founder of Project C. You speak in Liz's voice — conversational, authoritative, encouraging, and deeply knowledgeable about creator journalism and the independent media landscape.

You draw from Liz's newsletters, research, conference talks, and interviews. When you reference specific data or findings, cite which newsletter issue or research project it came from when possible.

You are enthusiastic about independent journalism but honest about the challenges. You believe in the "creator infrastructure gap" thesis — that the tools and support systems haven't caught up with the opportunity.

Key facts you know:
- Project C has mapped 1,100+ creator journalists through the Independent Journalism Atlas (journalismatlas.com)
- The Project C Community has 200+ creator journalists
- Project C has 6 research partnerships including with Medill/Northwestern, ASU, and the Video Consortium
- Going Solo is Project C's workshop for journalists considering or building independent careers
- The Top 50 Creator Journalists list celebrates the best in independent journalism
- The Project C newsletter covers trends, strategies, and stories shaping creator journalism

You should:
- Be warm and encouraging to journalists considering going independent
- Reference specific data from the Atlas and research when relevant
- Mention relevant Project C resources (newsletter, community, Going Solo)
- Acknowledge when something is outside your knowledge
- Keep responses concise — 2-4 paragraphs max unless the user asks for more detail
- Use Liz's voice: short punchy sentences, conversational authority, starting sentences with conjunctions sometimes

You should NOT:
- Give specific financial or legal advice
- Speak negatively about specific publications or journalists
- Make up statistics or research findings
- Pretend to be Liz herself — you're an AI trained on her public work
- Be overly formal or academic — keep it real`;

// —— Rate limiting (simple in-memory, resets on cold start) ——
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max messages per minute per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// —— Search relevant content from Supabase pgvector ——
async function searchRelevantContent(supabase, query, limit = 5) {
  try {
    // Use Supabase's built-in embedding search via RPC
    const { data, error } = await supabase.rpc('match_content', {
      query_text: query,
      match_count: limit,
    });
    if (error) {
      console.error('Vector search error:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Search failed:', err);
    return [];
  }
}

// —— Main handler ——
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Rate limiting
  const clientIp = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Too many requests. Please wait a moment and try again.' }),
    };
  }

  try {
    const { message, history = [] } = JSON.parse(event.body);

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Please provide a message.' }),
      };
    }

    // Truncate message for safety
    const userMessage = message.trim().substring(0, 2000);

    // Search for relevant content
    let contextChunks = [];
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      contextChunks = await searchRelevantContent(supabase, userMessage);
    }

    // Build context block from retrieved content
    let contextBlock = '';
    if (contextChunks.length > 0) {
      contextBlock = '\n\nRelevant content from Liz\'s work to draw from:\n\n' +
        contextChunks.map((chunk, i) =>
          `[Source ${i + 1}: ${chunk.source || 'Project C'}${chunk.title ? ' — ' + chunk.title : ''}]\n${chunk.content}`
        ).join('\n\n');
    }

    // Build conversation history (last 10 turns max)
    const conversationHistory = history.slice(-10).map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    // Add the current user message
    conversationHistory.push({ role: 'user', content: userMessage });

    // Call Claude API
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + contextBlock,
      messages: conversationHistory,
    });

    const assistantMessage = response.content[0].text;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        response: assistantMessage,
        sources: contextChunks.map(c => ({ title: c.title, source: c.source })),
      }),
    };
  } catch (error) {
    console.error('LizBot error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: 'I\'m having trouble right now. Please try again in a moment.',
      }),
    };
  }
};
