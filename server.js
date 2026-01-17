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
  res.json({ status: 'ok', message: 'CultureLens API is running' });
});

// Main scan endpoint
app.post('/api/scan', async (req, res) => {
  try {
    const { image, userId = 'default' } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Ask Gemini to identify if the image contains one of our 3 items
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: image
        }
      },
      `Look at this image and determine if it contains any of these items:
1. Zongzi (sticky rice dumpling wrapped in bamboo leaves)
2. Star anise (八角, the star-shaped spice)
3. Mooncake (月饼, round pastry with patterns)

If you see one of these items, respond with ONLY the item name (e.g., "zongzi", "star anise", or "mooncake").
If none of these items are visible, respond with "none".

Be generous - if it looks similar or is partially visible, identify it.`
    ]);

    const detected = result.response.text().trim();
    console.log('Gemini detected:', detected);

    // Match to our hardcoded content
    const culturalItem = matchCulturalItem(detected);

    if (!culturalItem) {
      return res.status(404).json({
        error: 'Item not recognized',
        message: 'Point at a zongzi, star anise, or mooncake to learn!'
      });
    }

    // Build response data
    const data = { ...culturalItem };

    // Check if user has seen this word before (spaced repetition)
    const existingWord = await Word.findOne({
      userId,
      english: data.english.toLowerCase()
    });

    let isReview = false;
    if (existingWord) {
      existingWord.timesSeenCount += 1;
      existingWord.lastSeen = new Date();
      existingWord.nextReview = new Date(Date.now() + existingWord.timesSeenCount * 24 * 60 * 60 * 1000);
      await existingWord.save();
      isReview = true;
      data.timesSeenCount = existingWord.timesSeenCount;
    } else {
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
