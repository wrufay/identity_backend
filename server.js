const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Word schema for spaced repetition
const wordSchema = new mongoose.Schema({
  userId: String,
  english: String,
  translation: String,
  pronunciation: String,
  culturalContext: String,
  timesSeenCount: { type: Number, default: 1 },
  lastSeen: { type: Date, default: Date.now },
  nextReview: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const Word = mongoose.model('Word', wordSchema);

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Anthropic
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Hardcoded cultural content for our 3 target items
const CULTURAL_ITEMS = {
  'zongzi': {
    english: 'Zongzi',
    translation: '粽子',
    pronunciation: 'zòngzi',
    culturalContext: 'Sticky rice wrapped in bamboo leaves, eaten during Dragon Boat Festival to honor Qu Yuan, a poet who drowned himself in protest. Families wrap them together — each region has its own filling style. The act of wrapping zongzi connects you to thousands of years of tradition.'
  },
  'star anise': {
    english: 'Star Anise',
    translation: '八角',
    pronunciation: 'bājiǎo',
    culturalContext: 'The "eight corners" spice is essential in Chinese five-spice powder and braised dishes. Its star shape represents luck and completeness. This is the smell of red-braised pork belly, of your grandmother\'s kitchen, of home.'
  },
  'mooncake': {
    english: 'Mooncake',
    translation: '月饼',
    pronunciation: 'yuèbǐng',
    culturalContext: 'Shared during Mid-Autumn Festival when families gather to admire the full moon. The round shape symbolizes completeness and reunion. Inside, sweet lotus paste or red bean — each bite a wish for family togetherness, even when far apart.'
  }
};

// Helper to match detected object to our items
function matchCulturalItem(detected) {
  const lower = detected.toLowerCase();

  // Check for matches (including partial matches)
  if (lower.includes('zongzi') || lower.includes('rice dumpling') || lower.includes('sticky rice')) {
    return CULTURAL_ITEMS['zongzi'];
  }
  if (lower.includes('star anise') || lower.includes('anise') || lower.includes('八角')) {
    return CULTURAL_ITEMS['star anise'];
  }
  if (lower.includes('mooncake') || lower.includes('moon cake') || lower.includes('月饼')) {
    return CULTURAL_ITEMS['mooncake'];
  }

  return null;
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ProjectOrigin API is running' });
});

// Main scan endpoint - using Gemini for everything
app.post('/api/scan', async (req, res) => {
  try {
    const { image, userId = 'default' } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Use Gemini to detect objects and generate cultural/historical context
    console.log('Starting Gemini detection...');
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.6,
        topP: 0.8,
        topK: 40,
      }
    });

    let geminiResult;
    try {
      geminiResult = await model.generateContent([
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: image
          }
        },
        `You are a knowledgeable cultural expert. Examine this image and identify the most prominent or interesting object, food, symbol, or item visible.

IMPORTANT INSTRUCTIONS:
- ALWAYS provide Chinese translation (simplified characters) and pinyin pronunciation for ALL objects, regardless of cultural origin
- If the object has specific cultural significance (Chinese or otherwise), include that context
- CRITICAL: Keep culturalContext to 150-180 characters maximum (about 2-3 lines). Be concise but meaningful.

Examples:

Chinese cultural item:
{
  "english": "Mooncake",
  "translation": "月饼",
  "pronunciation": "yuèbǐng",
  "culturalContext": "Shared during Mid-Autumn Festival. The round shape symbolizes family reunion, filled with sweet lotus paste or red bean."
}

Japanese cultural item:
{
  "english": "Matcha",
  "translation": "抹茶",
  "pronunciation": "matcha",
  "culturalContext": "Green tea powder central to Japanese tea ceremonies. Each whisked bowl embodies mindfulness and finding beauty in imperfection."
}

Universal everyday object:
{
  "english": "Water Bottle",
  "translation": "水瓶",
  "pronunciation": "shuǐpíng",
  "culturalContext": "A simple vessel for life's essential element. From ancient clay pots to modern containers, carrying water is a universal human need."
}

Modern tech object:
{
  "english": "Smartphone",
  "translation": "智能手机",
  "pronunciation": "zhìnéng shǒujī",
  "culturalContext": "Revolutionized human connection in just over a decade, transforming from luxury to necessity and reshaping how we communicate."
}

Food with cultural significance:
{
  "english": "Croissant",
  "translation": "羊角面包",
  "pronunciation": "yángjiǎo miànbāo",
  "culturalContext": "Flaky pastry with Viennese origins, now a symbol of French breakfast culture. The crescent shape celebrates a 17th-century victory."
}

Respond with ONLY valid JSON in this format. If NO clear object is visible, respond with: {"error": "none"}

Be generous in identification and make the cultural context engaging and educational.`
      ]);
      console.log('Gemini call completed successfully');
    } catch (geminiError) {
      console.error('Gemini API Error:', geminiError.message);
      console.error('Full error:', geminiError);
      return res.status(500).json({
        error: 'Failed to call Gemini API',
        details: geminiError.message
      });
    }

    let geminiText = geminiResult.response.text().trim();
    console.log('Raw Gemini response:', geminiText);

    // Remove markdown code blocks if present (```json ... ```)
    if (geminiText.startsWith('```')) {
      geminiText = geminiText.replace(/^```json?\n?/i, '').replace(/\n?```$/m, '').trim();
      console.log('After removing markdown:', geminiText);
    }

    // Parse Gemini's JSON response
    let culturalData;
    try {
      culturalData = JSON.parse(geminiText);
      console.log('Parsed cultural data:', culturalData);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError.message);
      console.error('Failed to parse Gemini response:', geminiText);
      console.error('Response length:', geminiText.length);
      console.error('First 200 chars:', geminiText.substring(0, 200));

      // Return a more helpful error
      return res.status(500).json({
        error: 'Failed to parse AI response',
        details: parseError.message,
        preview: geminiText.substring(0, 100)
      });
    }

    if (culturalData.error === 'none') {
      return res.status(404).json({
        error: 'Item not recognized',
        message: 'Point your camera at an object to learn about it!'
      });
    }

    // Build response data
    const data = {
      english: culturalData.english,
      translation: culturalData.translation,
      pronunciation: culturalData.pronunciation,
      culturalContext: culturalData.culturalContext
    };

    // Check if user has seen this word before (spaced repetition)
    const existingWord = await Word.findOne({
      userId,
      english: culturalData.english.toLowerCase()
    });

    let isReview = false;
    if (existingWord) {
      // Update existing word
      existingWord.timesSeenCount += 1;
      existingWord.lastSeen = new Date();
      existingWord.nextReview = new Date(Date.now() + existingWord.timesSeenCount * 24 * 60 * 60 * 1000);
      existingWord.translation = data.translation;
      existingWord.pronunciation = data.pronunciation;
      existingWord.culturalContext = data.culturalContext;
      await existingWord.save();
      isReview = true;
      data.timesSeenCount = existingWord.timesSeenCount;
    } else {
      // Save new word
      const newWord = new Word({
        userId,
        english: culturalData.english.toLowerCase(),
        translation: data.translation,
        pronunciation: data.pronunciation,
        culturalContext: data.culturalContext
      });
      await newWord.save();
      data.timesSeenCount = 1;
    }

    data.isReview = isReview;
    res.json(data);

  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: 'Failed to process image', details: error.message });
  }
});

// Get user's vocabulary
app.get('/api/vocabulary/:userId', async (req, res) => {
  try {
    const words = await Word.find({ userId: req.params.userId })
      .sort({ lastSeen: -1 });
    res.json(words);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vocabulary' });
  }
});

// Get words due for review
app.get('/api/review/:userId', async (req, res) => {
  try {
    const words = await Word.find({
      userId: req.params.userId,
      nextReview: { $lte: new Date() }
    }).sort({ nextReview: 1 });
    res.json(words);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch review words' });
  }
});

// Chat endpoint using Claude
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId = 'default', conversationHistory = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'No message provided' });
    }

    console.log('Chat request from user:', userId);
    console.log('Message:', message);

    // Get user's vocabulary for context
    const userWords = await Word.find({ userId }).sort({ lastSeen: -1 }).limit(20);
    const vocabularyContext = userWords.length > 0
      ? `The user has learned these Chinese words recently: ${userWords.map(w => `${w.english} (${w.translation}, ${w.pronunciation})`).join(', ')}.`
      : 'The user has not scanned any objects yet.';

    // Build conversation messages for Claude
    const messages = [
      ...conversationHistory.map(msg => ({
        role: msg.isUser ? 'user' : 'assistant',
        content: msg.text
      })),
      {
        role: 'user',
        content: message
      }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are Sunny, a friendly and knowledgeable cultural learning assistant in a mobile app that helps users learn Chinese language and culture by scanning real-world objects.

Your personality:
- Warm, encouraging, and patient like a favorite teacher
- Enthusiastic about Chinese culture and language
- Use simple, clear explanations suitable for learners
- Occasionally use relevant Chinese words/phrases with pinyin and meaning
- Keep responses concise (2-4 sentences usually) since this is a mobile chat

${vocabularyContext}

You can help users with:
- Explaining Chinese vocabulary, characters, and pronunciation
- Sharing cultural context about Chinese traditions, food, festivals
- Answering questions about objects they've scanned
- Providing language learning tips
- Discussing Chinese customs and their meanings

If users ask about non-Chinese cultural items, you can still be helpful and relate it back to Chinese language/culture when relevant.`,
      messages: messages
    });

    const aiResponse = response.content[0].text;
    console.log('Claude response:', aiResponse);

    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat', details: error.message });
  }
});

// Text-to-speech endpoint using ElevenLabs
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    console.log('TTS request for text:', text);
    console.log('Using API key:', process.env.ELEVENLABS_API_KEY ? 'Key exists' : 'NO KEY');

    // Use a Chinese voice ID for better pronunciation
    const voiceId = 'DowyQ68vDpgFYdWVGjc3'; // This should be a Chinese-capable voice

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs error status:', response.status);
      console.error('ElevenLabs error body:', errorText);
      return res.status(500).json({ error: 'ElevenLabs API error', details: errorText });
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    console.log('TTS success, audio length:', base64Audio.length);

    res.json({ audio: base64Audio });
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'Failed to generate speech', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
