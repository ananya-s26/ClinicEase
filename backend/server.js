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
const port = 3000;
const upload = multer({ dest: 'uploads/' });

if (config.GOOGLE_CLOUD_PROJECT) {
  process.env.GOOGLE_CLOUD_PROJECT = config.GOOGLE_CLOUD_PROJECT;
}

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'google-cloud-key.json');

let visionClient;
try {
  const visionApiKey = config.GOOGLE_VISION_API_KEY;
  if (visionApiKey && visionApiKey !== 'your_google_vision_api_key_here') {
    visionClient = new ImageAnnotatorClient({
      apiKey: visionApiKey,
      projectId: process.env.GOOGLE_CLOUD_PROJECT
    });
    console.log('✅ Google Cloud Vision client initialized with API key');
  } else {
    visionClient = new ImageAnnotatorClient({
      keyFilename: credentialsPath,
      projectId: process.env.GOOGLE_CLOUD_PROJECT
    });
    console.log('✅ Google Cloud Vision client initialized with service account');
  }
} catch (error) {
  console.error('❌ Error initializing Google Cloud Vision client:', error);
  console.log('💡 To fix this, either:');
  console.log('   1. Set GOOGLE_VISION_API_KEY in backend/.env, or');
  console.log('   2. Set GOOGLE_APPLICATION_CREDENTIALS to a valid service account JSON path');
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

app.use(express.json());

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
- Extract ALL medicines mentioned in the prescription
- If timing/frequency/instructions are not specified, use "Not specified"
- Be specific with dosages (include units like mg, ml, tablets)
- Include any special instructions or warnings
- Only return valid JSON, no extra text

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

app.post('/upload', upload.single('prescription'), async (req, res) => {
  console.log('Received upload request');
  try {
    if (!req.file) {
      console.error('No file uploaded.');
      return res.status(400).send('No file uploaded.');
    }
    const imagePath = path.join(__dirname, req.file.path);
    console.log('Image path:', imagePath);
    try {
      console.log('Attempting to process image with Vision API...');
      const [result] = await visionClient.textDetection(imagePath);
      const text = result.textAnnotations[0]?.description || 'No text detected';
      console.log('OCR text extracted:', text);
      if (text === 'No text detected') {
        throw new Error('No text could be detected from the image. Please ensure the prescription is clearly visible and readable.');
      }
      const extractedData = await extractMedicinesAndDosages(text);
      console.log('Extracted data from Gemini:', extractedData);
      try {
        const parsedData = JSON.parse(extractedData);
        res.json(parsedData);
      } catch (parseError) {
        console.error('JSON Parsing Error:', parseError, extractedData);
        res.status(500).send('Error parsing the extracted data. Please try again with a clearer image.');
      }
    } catch (visionError) {
      console.error('Vision API Error:', visionError);
      res.status(500).send(`Failed to process image: ${visionError.message}. Please ensure the image is clear and readable.`);
    }
  } catch (error) {
    console.error('Error in /upload:', error);
    res.status(500).send('An error occurred while processing the image.');
  }
});

app.get('/test', (req, res) => {
  res.json({ message: 'Server is running!' });
});

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

const server = app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
  console.log('✅ Press Ctrl+C to stop the server');
  try {
    initializeReminderScheduler('0 9 * * *');
    console.log('📅 Appointment reminder scheduler initialized');
  } catch (error) {
    console.error('❌ Failed to initialize reminder scheduler:', error);
  }
});

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

app.get(/.*/, (req, res) => {
  if (process.env.NODE_ENV === 'development' || !fs.existsSync(path.join(distDir, 'index.html'))) {
    return res.status(404).send('Backend API Server - Route not found. Access frontend at http://localhost:5173');
  }
  return res.sendFile(path.join(distDir, 'index.html'));
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
