import express from 'express';
import multer from 'multer';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cors from 'cors';
import fs from 'fs';
import { config } from './config.js';
import { initializeReminderScheduler } from './src/server/reminderScheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ FIXED: Use Render dynamic port
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });

if (config.GOOGLE_CLOUD_PROJECT) {
  process.env.GOOGLE_CLOUD_PROJECT = config.GOOGLE_CLOUD_PROJECT;
}

// Debug: Check environment variables
console.log('Environment check:', {
  hasCredentialsJson: !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  hasCredentialsPath: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
  hasApiKey: !!config.GOOGLE_VISION_API_KEY,
  projectFromConfig: config.GOOGLE_CLOUD_PROJECT
});

const credentialsPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, 'google-cloud-key.json');

// Debug: Check if file exists
console.log('Credentials path:', credentialsPath);
console.log('File exists:', fs.existsSync(credentialsPath));

let visionClient;
try {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (credentialsJson) {
    // Use JSON from environment variable
    const credentials = JSON.parse(credentialsJson);
    visionClient = new ImageAnnotatorClient({
      credentials: credentials,
      projectId: credentials.project_id
    });
    console.log('Google Cloud Vision client initialized with JSON environment variable');
  } else {
    // Use service account file
    visionClient = new ImageAnnotatorClient({
      keyFilename: credentialsPath,
      projectId: process.env.GOOGLE_CLOUD_PROJECT
    });
    console.log('Google Cloud Vision client initialized with service account file');
  }
} catch (error) {
  console.error('❌ Error initializing Google Cloud Vision client:', error);
  process.exit(1);
}

const apiKey = config.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY not found in environment variables');
  process.exit(1);
}

let genAI;
try {
  genAI = new GoogleGenerativeAI(apiKey);
  console.log('✅ Gemini AI client initialized successfully');
} catch (error) {
  console.error('❌ Error initializing Gemini AI client:', error);
  process.exit(1);
}

// ---------------- HELPERS ----------------

function cleanGeminiResponse(rawResponse) {
  return rawResponse.replace(/```json\s*/g, '').replace(/```/g, '').trim();
}

async function extractMedicinesAndDosages(ocrText) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

    const prompt = `
Extract all medicine names, dosages, timing, frequency, and instructions from the following prescription text. 
Return the data in this exact JSON format:
{
  "medicines": [
    {
      "name": "Medicine Name",
      "dosage": "Dosage (e.g., 500mg, 1 tablet)",
      "timing": "When to take (e.g., morning, evening, before meals)",
      "frequency": "How often (e.g., twice daily, once daily)",
      "instructions": "Special instructions (e.g., take with food, avoid alcohol)"
    }
  ]
}

Important:
- Extract ALL medicines mentioned
- If missing fields → "Not specified"
- Only return valid JSON

Prescription text: "${ocrText}"
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    if (!response) throw new Error('No response from Gemini API.');

    return cleanGeminiResponse(response.text());
  } catch (error) {
    console.error('Gemini API Error:', error);
    throw new Error('Failed to extract medicine details.');
  }
}

// ---------------- ROUTES ----------------

// test route
app.get('/test', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// upload route
app.post('/upload', upload.single('prescription'), async (req, res) => {
  console.log('Received upload request');

  try {
    if (!req.file) {
      console.error('No file uploaded.');
      return res.status(400).send('No file uploaded.');
    }

    const imagePath = path.join(__dirname, req.file.path);

    console.log('Processing image:', imagePath);

    const [result] = await visionClient.textDetection(imagePath);
    const text = result.textAnnotations[0]?.description || 'No text detected';

    if (text === 'No text detected') {
      throw new Error('No readable text found.');
    }

    const extractedData = await extractMedicinesAndDosages(text);
    const parsedData = JSON.parse(extractedData);

    res.json(parsedData);

  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).send(error.message);
  }
});

// reminders route
app.post('/trigger-reminders', async (req, res) => {
  try {
    const { triggerRemindersManually } = await import('./src/server/reminderScheduler.js');
    const results = await triggerRemindersManually();

    res.json({
      success: true,
      message: 'Reminders triggered successfully',
      results
    });
  } catch (error) {
    console.error('Error triggering reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger reminders',
      error: error.message
    });
  }
});

// ---------------- STATIC ----------------

const distDir = path.join(__dirname, 'dist');
const publicDir = path.join(__dirname, 'public');
const rootUploadsDir = path.join(__dirname, '..', 'uploads');

if (fs.existsSync(rootUploadsDir)) {
  app.use('/uploads', express.static(rootUploadsDir));
  console.log('✅ Root uploads directory served at /uploads');
}

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
} else if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  console.log('⚠️ Frontend static files not found. Backend running in API-only mode.');
}

// ❌ REMOVED: catch-all route (this was breaking everything)

// ---------------- START SERVER ----------------

const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);

  try {
    initializeReminderScheduler('0 9 * * *');
    console.log('📅 Appointment reminder scheduler initialized');
  } catch (error) {
    console.error('❌ Failed to initialize reminder scheduler:', error);
  }
});

// ---------------- ERROR HANDLING ----------------

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});