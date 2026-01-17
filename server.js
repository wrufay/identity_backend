const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'CultureLens API is running' });
});

// Main scan endpoint
app.post('/api/scan', async (req, res) => {
  try {
    const { image, userId = 'default' } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: image
        }
      },
      `You are a cultural education assistant helping Chinese-Americans/Canadians reconnect with their heritage.

Identify the main object or text in this image. Return ONLY valid JSON (no markdown) with these fields:
- "english": the English word/phrase for what you see
- "translation": Chinese characters (Simplified)
- "pronunciation": pinyin with tone marks (e.g., "jiǎozi" not "jiaozi")
- "culturalContext": 2-3 sentences about the cultural significance for Chinese heritage. Make it personal and meaningful - mention traditions, family connections, or historical context. Write as if speaking to someone reconnecting with their roots.

Example response:
{"english":"dumpling","translation":"饺子","pronunciation":"jiǎozi","culturalContext":"Made during Chinese New Year, each fold is a wish for prosperity. Shaped like ancient gold ingots to invite wealth. Your grandmother probably folded these with her own grandmother."}`
    ]);

    const text = result.response.text();

    // Parse the JSON response
    let data;
    try {
      // Remove any markdown code blocks if present
      const cleanText = text.replace(/```json?|```/g, '').trim();
      data = JSON.parse(cleanText);
    } catch (parseError) {
      console.error('Failed to parse Gemini response:', text);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // Check if user has seen this word before
    const existingWord = await Word.findOne({
      userId,
      english: data.english.toLowerCase()
    });

    let isReview = false;
    if (existingWord) {
      // Update existing word
      existingWord.timesSeenCount += 1;
      existingWord.lastSeen = new Date();
      // Simple spaced repetition: next review in (count * 1 day)
      existingWord.nextReview = new Date(Date.now() + existingWord.timesSeenCount * 24 * 60 * 60 * 1000);
      await existingWord.save();
      isReview = true;
      data.timesSeenCount = existingWord.timesSeenCount;
    } else {
      // Save new word
      const newWord = new Word({
        userId,
        english: data.english.toLowerCase(),
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
    res.status(500).json({ error: 'Failed to process image' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
