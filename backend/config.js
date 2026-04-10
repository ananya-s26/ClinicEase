import dotenv from 'dotenv';
dotenv.config();

// Configuration file for API keys and settings
export const config = {
    // Google Cloud Vision API Key - read from environment variable
    GOOGLE_VISION_API_KEY: process.env.GOOGLE_VISION_API_KEY,
    
    // Gemini AI API Key - read from environment variable
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY,
    
    // Google Cloud Project ID - read from environment variable
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,

};