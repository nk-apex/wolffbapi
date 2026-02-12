import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'temp');
try {
  await fs.mkdir(TEMP_DIR, { recursive: true });
} catch (err) {
  console.log('Temp directory already exists');
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: '🐺 Wolf Facebook Downloader',
    version: '1.0.0',
    endpoints: {
      download: '/api/download?url=FB_URL',
      info: '/api/info?url=FB_URL',
      direct: '/api/direct?url=FB_URL',
      batch: '/api/batch (POST)'
    }
  });
});

// Get video info without downloading
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!isValidFacebookUrl(url)) {
      return res.status(400).json({ error: 'Invalid Facebook URL' });
    }

    console.log(`[INFO] Fetching info for: ${url}`);

    const cmd = `yt-dlp --dump-json --no-playlist "${url}"`;
    const { stdout } = await execAsync(cmd);
    const info = JSON.parse(stdout);

    res.json({
      success: true,
      title: info.title || 'Facebook Video',
      duration: info.duration || 0,
      uploader: info.uploader || 'Unknown',
      uploader_url: info.uploader_url || null,
      thumbnail: info.thumbnail || null,
      filesize: info.filesize || info.filesize_approx || null
    });

  } catch (error) {
    console.error('[INFO ERROR]:', error);
    res.status(500).json({ 
      error: 'Failed to fetch video info',
      details: error.message 
    });
  }
});

// Download video
app.get('/api/download', async (req, res) => {
  let tempFile = null;
  
  try {
    const { url, quality = 'best' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!isValidFacebookUrl(url)) {
      return res.status(400).json({ error: 'Invalid Facebook URL' });
    }

    console.log(`[DOWNLOAD] Processing: ${url}`);

    const fileId = crypto.randomBytes(16).toString('hex');
    tempFile = path.join(TEMP_DIR, `fb_${fileId}.mp4`);

    // Format selection
    let format = 'best[ext=mp4]';
    if (quality === 'hd') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]';
    if (quality === 'sd') format = 'worst[ext=mp4]';

    const cmd = `yt-dlp -f "${format}" --no-playlist -o "${tempFile}" "${url}"`;
    
    await execAsync(cmd, { timeout: 300000 });

    await fs.access(tempFile);
    const stats = await fs.stat(tempFile);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="facebook_video_${fileId}.mp4"`);
    res.setHeader('Content-Length', stats.size);
    
    const fileStream = require('fs').createReadStream(tempFile);
    fileStream.pipe(res);

    fileStream.on('end', async () => {
      try {
        await fs.unlink(tempFile);
        console.log(`[CLEANUP] Deleted: ${tempFile}`);
      } catch (err) {
        console.error('[CLEANUP ERROR]:', err);
      }
    });

  } catch (error) {
    console.error('[DOWNLOAD ERROR]:', error);
    
    if (tempFile) {
      try {
        await fs.access(tempFile);
        await fs.unlink(tempFile);
      } catch (err) {}
    }

    if (error.message.includes('timed out')) {
      return res.status(408).json({ error: 'Download timeout - video too large' });
    }
    
    if (error.message.includes('Video unavailable')) {
      return res.status(404).json({ error: 'Video unavailable or private' });
    }

    res.status(500).json({ 
      error: 'Download failed',
      details: error.message 
    });
  }
});

// Direct download link
app.get('/api/direct', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).send('URL parameter required');
    }

    const cmd = `yt-dlp -g -f "best[ext=mp4]" "${url}"`;
    const { stdout } = await execAsync(cmd);
    const directUrl = stdout.trim();

    res.json({ 
      success: true, 
      direct_url: directUrl,
      url: url 
    });

  } catch (error) {
    console.error('[DIRECT ERROR]:', error);
    res.status(500).json({ error: 'Failed to get direct URL' });
  }
});

// Batch download
app.post('/api/batch', async (req, res) => {
  try {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: 'URLs array required' });
    }

    const results = [];
    
    for (const url of urls) {
      try {
        const fileId = crypto.randomBytes(16).toString('hex');
        const tempFile = path.join(TEMP_DIR, `fb_${fileId}.mp4`);
        
        await execAsync(`yt-dlp -f "best[ext=mp4]" --no-playlist -o "${tempFile}" "${url}"`);
        
        const stats = await fs.stat(tempFile);
        
        results.push({
          url,
          success: true,
          fileSize: stats.size,
          downloadUrl: `/api/download?url=${encodeURIComponent(url)}`
        });
        
        await fs.unlink(tempFile);
        
      } catch (error) {
        results.push({
          url,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      processed: results.length,
      results
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// URL validation
function isValidFacebookUrl(url) {
  const patterns = [
    /^https?:\/\/(www\.|m\.)?facebook\.com\/.*/i,
    /^https?:\/\/(www\.|m\.)?fb\.com\/.*/i,
    /^https?:\/\/(www\.|m\.)?fb\.watch\/.*/i,
    /^https?:\/\/(www\.)?facebook\.com\/watch\/.*/i,
    /^https?:\/\/(www\.)?facebook\.com\/reel\/.*/i
  ];
  return patterns.some(pattern => pattern.test(url));
}

// Clean old files
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      const age = now - stats.mtimeMs;
      
      if (age > 600000) {
        await fs.unlink(filePath);
        console.log(`[CLEANUP] Removed: ${file}`);
      }
    }
  } catch (error) {
    console.error('[CLEANUP ERROR]:', error);
  }
}, 300000);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🐺 Wolf Facebook Downloader API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 Server: http://localhost:${PORT}
📦 Endpoints ready!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});