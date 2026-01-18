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
- If the object has Chinese cultural significance, provide Chinese translation (simplified characters) and pinyin pronunciation with detailed cultural context
- If the object is from another culture, provide translation in that language if relevant (e.g., Japanese items in Japanese, French items in French)
- If the object is universal/modern with no specific cultural ties, just use the English name for translation (or keep pronunciation empty)

Examples:

Chinese cultural item:
{
  "english": "Mooncake",
  "translation": "月饼",
  "pronunciation": "yuèbǐng",
  "culturalContext": "Shared during Mid-Autumn Festival when families gather to admire the full moon. The round shape symbolizes completeness and reunion. Inside, sweet lotus paste or red bean — each bite a wish for family togetherness, even when far apart."
}

Japanese cultural item:
{
  "english": "Matcha",
  "translation": "抹茶",
  "pronunciation": "matcha",
  "culturalContext": "Finely ground green tea powder central to Japanese tea ceremonies. Whisked into a frothy drink, it embodies wabi-sabi — finding beauty in imperfection. Each bowl is a meditation, each sip a moment of mindfulness."
}

Universal everyday object:
{
  "english": "Water Bottle",
  "translation": "Water Bottle",
  "pronunciation": "",
  "culturalContext": "A simple vessel that carries life's essential element. From ancient clay pots to modern insulated containers, humans have always needed to carry water — a reminder that some needs transcend culture and time."
}

Modern tech object:
{
  "english": "Smartphone",
  "translation": "Smartphone",
  "pronunciation": "",
  "culturalContext": "This pocket-sized computer has revolutionized human connection, putting the world's knowledge at our fingertips. In just over a decade, it transformed from luxury to necessity, reshaping how we communicate, work, and experience reality."
}

Food with cultural significance:
{
  "english": "Croissant",
  "translation": "Croissant",
  "pronunciation": "krwah-sahn",
  "culturalContext": "Despite its association with France, this flaky pastry originated in Vienna. The crescent shape celebrates a 17th-century victory over the Ottoman Empire. Now a symbol of French breakfast culture, each layer represents centuries of culinary refinement."
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
