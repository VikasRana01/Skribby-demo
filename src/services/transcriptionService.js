// Download meeting audio from Skribby recording_url, transcribe with YOUR API only (OpenAI key never sent to Skribby).
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const FormData = require('form-data');
require('dotenv').config();

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  flac: 'audio/flac',
};

function getTranscriptionOpenAI() {
  const apiKey =
    process.env.TRANSCRIPTION_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Set TRANSCRIPTION_OPENAI_API_KEY or OPENAI_API_KEY for transcription');
  const baseURL =
    (process.env.TRANSCRIPTION_OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '').trim() || undefined;
  return new OpenAI({ apiKey, baseURL });
}

/** Safe fragment for archive filenames (Skribby bot id may contain punctuation). */
function sanitizeBotIdForFilename(botId) {
  if (botId == null || botId === '') return '';
  return String(botId).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 200);
}

function archiveBasename(botId, fileExtension) {
  const safe = sanitizeBotIdForFilename(botId);
  if (safe) return `skribby_bot_${safe}.${fileExtension}`;
  return `skribby_audio_${Date.now()}.${fileExtension}`;
}

/** Optional archive folder; temp files for STT always use a dedicated temp dir and are removed after. */
function getAudioDownloadDir() {
  const raw = (process.env.TRANSCRIPTION_AUDIO_DOWNLOAD_DIR || '').trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  }
  return path.join(process.cwd(), 'downloads', 'skribby-audio');
}

function keepAudioArchiveCopy() {
  return !['false', '0', 'no'].includes(
    String(process.env.TRANSCRIPTION_KEEP_AUDIO_COPY || 'true').toLowerCase()
  );
}

async function getTranscriptionTempDir() {
  const preferred = path.join(__dirname, '../../temp');
  try {
    await fs.promises.mkdir(preferred, { recursive: true });
    return preferred;
  } catch (e) {
    console.warn(`⚠️ Transcription: could not use ${preferred} — ${e.message}; using os.tmpdir()`);
    return os.tmpdir();
  }
}

async function downloadFile(url, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const response = await axios.get(url, {
    responseType: 'stream',
    maxRedirects: 10,
    timeout: 10 * 60 * 1000,
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    const onError = (err) => {
      writer.close();
      fs.unlink(destPath, () => {});
      reject(err);
    };
    response.data.pipe(writer);
    response.data.on('error', onError);
    writer.on('finish', resolve);
    writer.on('error', onError);
  });
}

/** @returns {Promise<Buffer>} */
async function downloadRecordingToBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    maxRedirects: 10,
    timeout: 10 * 60 * 1000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return Buffer.from(res.data);
}

function maxRecordingMb() {
  const n = parseFloat(process.env.TRANSCRIPTION_MAX_FILE_MB || '24', 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function cleanTranscriptionText(text) {
  if (text == null) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

/** ISO-639-1 for Whisper; empty = auto-detect (do not reuse SKRIBBY_LANG — that is for Skribby’s bot, not meeting language). */
function transcriptionLanguageHint() {
  const raw = (process.env.TRANSCRIPTION_LANGUAGE || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return undefined;
  return raw.slice(0, 5);
}

/** Drop segments that look like silence hallucinations (Whisper loops on noise). */
function segmentFilters() {
  const nsp = parseFloat(process.env.TRANSCRIPTION_SEGMENT_MAX_NO_SPEECH_PROB || '0.45', 10);
  const cr = parseFloat(process.env.TRANSCRIPTION_SEGMENT_MAX_COMPRESSION_RATIO || '2.4', 10);
  return {
    maxNoSpeechProb: Number.isFinite(nsp) ? nsp : 0.45,
    maxCompressionRatio: Number.isFinite(cr) ? cr : 2.4,
  };
}

/**
 * Collapse long runs where the same multi-word phrase repeats (common Hindi/English loop on silence).
 */
function collapseRepeatedPhraseRuns(text, minWords = 8, minRuns = 4) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(/\s+/);
  if (words.length < minWords * minRuns) return text;

  const out = [];
  let i = 0;
  while (i < words.length) {
    let advanced = false;
    const maxLen = Math.min(40, words.length - i);
    for (let len = maxLen; len >= minWords; len--) {
      const phrase = words.slice(i, i + len).join(' ');
      let k = i + len;
      let runs = 1;
      while (k + len <= words.length && words.slice(k, k + len).join(' ') === phrase) {
        runs++;
        k += len;
      }
      if (runs >= minRuns) {
        out.push(phrase);
        i = k;
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(' ');
}

/** Consecutive duplicate sentences (normalized). */
function dedupeConsecutiveSentences(text) {
  const parts = String(text)
    .split(/(?<=[.!?।॥])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let lastKey = '';
  for (const p of parts) {
    const key = p.replace(/\s+/g, ' ').toLowerCase();
    if (key === lastKey) continue;
    lastKey = key;
    out.push(p);
  }
  return out.join(' ').trim();
}

/**
 * Build transcript from verbose_json segments + quality filters + repetition cleanup.
 */
function refineTranscriptFromVerboseResponse(response) {
  const rawFull = response && typeof response === 'object' ? String(response.text || '').trim() : '';
  const segs = response && Array.isArray(response.segments) ? response.segments : null;
  if (!segs || segs.length === 0) {
    let t = cleanTranscriptionText(rawFull);
    t = collapseRepeatedPhraseRuns(t);
    t = dedupeConsecutiveSentences(t);
    return t;
  }

  const { maxNoSpeechProb, maxCompressionRatio } = segmentFilters();
  const kept = segs.filter((seg) => {
    const nsp = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0;
    const cr = typeof seg.compression_ratio === 'number' ? seg.compression_ratio : 1;
    return nsp <= maxNoSpeechProb && cr <= maxCompressionRatio;
  });

  if (kept.length === 0) {
    let t = cleanTranscriptionText(rawFull);
    t = collapseRepeatedPhraseRuns(t);
    t = dedupeConsecutiveSentences(t);
    return t;
  }

  let text = kept
    .map((s) => String(s.text || '').trim())
    .filter(Boolean)
    .join(' ');

  text = cleanTranscriptionText(text);
  if (!text && rawFull) {
    text = cleanTranscriptionText(rawFull);
  }
  text = collapseRepeatedPhraseRuns(text);
  text = dedupeConsecutiveSentences(text);
  return text;
}

/**
 * Magic-byte + URL hint; aligns file extension / MIME for Whisper upload.
 * @param {Buffer} buffer
 * @param {{ recordingUrl?: string, mimeType?: string, fileExtension?: string }} [options]
 */
function detectAudioFormat(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Audio buffer is empty or invalid');
  }

  const hintExt = String(options.fileExtension || '')
    .replace(/^\./, '')
    .toLowerCase();
  const hintMime = options.mimeType;

  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { fileExtension: 'webm', mimeType: 'audio/webm' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return { fileExtension: 'wav', mimeType: 'audio/wav' };
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return { fileExtension: 'ogg', mimeType: 'audio/ogg' };
  }
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') {
    return { fileExtension: 'mp3', mimeType: 'audio/mpeg' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { fileExtension: 'mp3', mimeType: 'audio/mpeg' };
  }
  if (buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return { fileExtension: 'm4a', mimeType: 'audio/mp4' };
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') {
    return { fileExtension: 'flac', mimeType: 'audio/flac' };
  }

  const fromUrl = /\.(mp3|wav|m4a|ogg|webm|mp4|mpeg|mpga|flac)(\?|$)/i.exec(options.recordingUrl || '')?.[1];
  if (fromUrl) {
    const ext = fromUrl.toLowerCase();
    return { fileExtension: ext, mimeType: MIME_BY_EXT[ext] || 'application/octet-stream' };
  }
  if (hintExt && MIME_BY_EXT[hintExt]) {
    return { fileExtension: hintExt, mimeType: hintMime || MIME_BY_EXT[hintExt] };
  }

  return { fileExtension: 'mp4', mimeType: 'audio/mp4' };
}

function resolveWhisperModel(name) {
  const n = (name || 'whisper-1').trim();
  const lower = n.toLowerCase();
  const ok =
    lower === 'whisper-1' ||
    lower.includes('whisper') ||
    lower.startsWith('gpt-4o-transcribe') ||
    lower.startsWith('gpt-4o-mini-transcribe');
  if (!ok) {
    console.warn(
      `⚠️ Transcription: model "${n}" may not be supported by the audio transcriptions API; using whisper-1`
    );
    return 'whisper-1';
  }
  return n;
}

/**
 * Single OpenAI STT path: buffer → format detect → temp file → verbose_json → cleanup.
 * @param {Buffer} audioBuffer
 * @param {{ recordingUrl?: string, botId?: string }} [meta]
 * @returns {Promise<{ text: string, response: object, archiveFilename: string | null }>}
 */
async function executeOpenAITranscriptionV1(audioBuffer, meta = {}) {
  const openai = getTranscriptionOpenAI();
  let model = resolveWhisperModel((process.env.TRANSCRIPTION_WHISPER_MODEL || 'whisper-1').trim());

  const { fileExtension, mimeType } = detectAudioFormat(audioBuffer, {
    recordingUrl: meta.recordingUrl,
  });

  console.log(
    `🎵 V1 format — url hint: ${meta.recordingUrl ? meta.recordingUrl.slice(0, 60) + '…' : 'none'}, ext: ${fileExtension}, mime: ${mimeType}`
  );

  const baseName = archiveBasename(meta.botId, fileExtension);
  const archive = keepAudioArchiveCopy();
  const workDir = archive ? getAudioDownloadDir() : await getTranscriptionTempDir();
  const workPath = path.join(workDir, baseName);
  const removeAfter = !archive;

  const temp = (process.env.TRANSCRIPTION_WHISPER_TEMPERATURE || '').trim();
  const prompt = (process.env.TRANSCRIPTION_WHISPER_PROMPT || '').trim();

  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    await fs.promises.writeFile(workPath, audioBuffer);
    if (archive) {
      console.log(`🎙️ Transcription: audio on disk (single write) — ${workPath}`);
    }

    const transcriptionOptions = {
      file: fs.createReadStream(workPath),
      model,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };

    const lang = transcriptionLanguageHint();
    if (lang) {
      transcriptionOptions.language = lang;
      console.log(`🎵 V1 language hint: ${lang}`);
    }

    if (temp !== '' && !Number.isNaN(Number(temp))) {
      transcriptionOptions.temperature = Number(temp);
    } else {
      transcriptionOptions.temperature = 0;
    }
    console.log(`🎵 V1 temperature: ${transcriptionOptions.temperature}`);

    if (prompt) {
      transcriptionOptions.prompt = prompt;
      console.log(`🎵 V1 prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '…' : ''}`);
    }

    console.log(`🎙️ Transcription: OpenAI audio.transcriptions.create model="${model}" verbose_json+segments`);

    const response = await openai.audio.transcriptions.create(transcriptionOptions);

    let text = '';
    if (typeof response === 'string') {
      text = cleanTranscriptionText(response);
      text = collapseRepeatedPhraseRuns(text);
      text = dedupeConsecutiveSentences(text);
    } else if (response && typeof response === 'object') {
      text = refineTranscriptFromVerboseResponse(response);
    }

    console.log(`🎙️ Transcription: ${text.length} chars (after segment + repetition cleanup)`);
    return {
      text,
      response,
      archiveFilename: removeAfter ? null : path.basename(workPath),
    };
  } finally {
    if (removeAfter) {
      try {
        await fs.promises.unlink(workPath);
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`⚠️ Transcription: temp cleanup: ${e.message}`);
      }
    }
  }
}

/**
 * Download Skribby recording, transcribe on this server only (OpenAI key stays here).
 */
async function transcribeWithOpenAIWhisper(recordingUrl, options = {}) {
  console.log(`🎙️ Transcription: downloading audio — ${recordingUrl.slice(0, 80)}…`);

  const audioBuffer = await downloadRecordingToBuffer(recordingUrl);
  const maxBytes = maxRecordingMb() * 1024 * 1024;
  console.log(
    `🎙️ Transcription: buffer size = ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB (limit ${maxRecordingMb()} MB)`
  );

  if (audioBuffer.length > maxBytes) {
    throw new Error(
      `Recording is ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB — exceeds TRANSCRIPTION_MAX_FILE_MB (${maxRecordingMb()}).`
    );
  }

  const { text, archiveFilename } = await executeOpenAITranscriptionV1(audioBuffer, {
    recordingUrl,
    botId: options.botId,
  });
  return { text, mediaFilename: archiveFilename };
}

/**
 * POST multipart file to your STT endpoint; expects JSON with text/transcript or plain body.
 */
async function transcribeWithCustomHttp(recordingUrl, options = {}) {
  const url = (process.env.TRANSCRIPTION_HTTP_URL || '').trim();
  if (!url) throw new Error('TRANSCRIPTION_HTTP_URL is required for recording_custom_http');

  const audioBuffer = await downloadRecordingToBuffer(recordingUrl);
  const maxBytes = maxRecordingMb() * 1024 * 1024;
  if (audioBuffer.length > maxBytes) {
    throw new Error(`Recording exceeds TRANSCRIPTION_MAX_FILE_MB (${maxRecordingMb()}).`);
  }

  const { fileExtension, mimeType } = detectAudioFormat(audioBuffer, { recordingUrl });

  let mediaFilename = null;
  if (keepAudioArchiveCopy()) {
    const archiveDir = getAudioDownloadDir();
    await fs.promises.mkdir(archiveDir, { recursive: true });
    const baseName = archiveBasename(options.botId, fileExtension);
    const archivePath = path.join(archiveDir, baseName);
    await fs.promises.writeFile(archivePath, audioBuffer);
    mediaFilename = baseName;
    console.log(`🎙️ Transcription: archived copy — ${archivePath}`);
  }

  const field = (process.env.TRANSCRIPTION_HTTP_FILE_FIELD || 'file').trim();
  const form = new FormData();
  form.append(field, audioBuffer, {
    filename: `recording.${fileExtension}`,
    contentType: mimeType,
  });

  const headers = { ...form.getHeaders() };
  const apiKey = (process.env.TRANSCRIPTION_HTTP_API_KEY || '').trim();
  const authHeader = (process.env.TRANSCRIPTION_HTTP_AUTH_HEADER || 'Authorization').trim();
  if (apiKey) {
    const prefix = (process.env.TRANSCRIPTION_HTTP_AUTH_PREFIX || 'Bearer ').trim();
    headers[authHeader] = apiKey.startsWith('Bearer ') ? apiKey : `${prefix}${apiKey}`;
  }

  console.log(`🎙️ Transcription: POST ${url}`);
  const res = await axios.post(url, form, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 15 * 60 * 1000,
  });

  const { data } = res;
  const ct = res.headers['content-type'] || '';

  let textOut = '';
  if (ct.includes('application/json') && data && typeof data === 'object') {
    const text =
      data.text ||
      data.transcript ||
      data.data?.text ||
      (typeof data.result === 'string' ? data.result : null);
    if (text) textOut = String(text);
  } else if (typeof data === 'string') {
    textOut = data;
  } else {
    textOut = JSON.stringify(data);
  }
  return { text: textOut, mediaFilename };
}

/**
 * @param {'recording_openai_whisper'|'recording_custom_http'} mode
 * @param {{ botId?: string }} [options]
 * @returns {Promise<{ text: string, mediaFilename: string | null }>}
 */
async function transcribeFromRecordingUrl(recordingUrl, mode, options = {}) {
  if (mode === 'recording_custom_http') return transcribeWithCustomHttp(recordingUrl, options);
  return transcribeWithOpenAIWhisper(recordingUrl, options);
}

const ARCHIVE_NAME_RE = /^skribby_(audio|bot)_/;
const ARCHIVE_EXT_RE = /\.(mp3|wav|m4a|ogg|webm|mp4|mpeg|mpga|flac)$/i;

/**
 * Resolve path to an archived recording under downloads/skribby-audio (or TRANSCRIPTION_AUDIO_DOWNLOAD_DIR).
 * @param {string|null|undefined} botId
 * @param {string|null|undefined} mediaArchiveFilename
 * @param {{ referenceTime?: Date|string|null }} [opts] — used to pick among legacy skribby_audio_<timestamp>.* files
 */
async function resolveArchivedRecordingPath(botId, mediaArchiveFilename, opts = {}) {
  const dir = path.resolve(getAudioDownloadDir());
  const dirPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  const safe = sanitizeBotIdForFilename(botId);

  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (_) {
    return null;
  }

  const candidates = entries.filter(
    (f) => ARCHIVE_NAME_RE.test(f) && ARCHIVE_EXT_RE.test(f)
  );

  async function toVerifiedFull(fileName) {
    if (!fileName || fileName.includes('..')) return null;
    const full = path.resolve(path.join(dir, path.basename(fileName)));
    if (full !== dir && !full.startsWith(dirPrefix)) return null;
    try {
      await fs.promises.access(full);
      return full;
    } catch (_) {
      return null;
    }
  }

  if (mediaArchiveFilename) {
    const base = path.basename(mediaArchiveFilename);
    const got = await toVerifiedFull(base);
    if (got) return got;
  }

  if (safe) {
    const prefix = `skribby_bot_${safe}.`;
    const hit = candidates.find((f) => f.startsWith(prefix));
    if (hit) {
      const got = await toVerifiedFull(hit);
      if (got) return got;
    }
  }

  if (candidates.length === 1) {
    return toVerifiedFull(candidates[0]);
  }

  const refRaw = opts.referenceTime;
  const ref = refRaw != null ? new Date(refRaw) : null;
  const refOk = ref && !Number.isNaN(ref.getTime());
  if (refOk && candidates.length > 0) {
    const windowMs = Math.max(
      1,
      parseInt(process.env.TRANSCRIPTION_ARCHIVE_MATCH_WINDOW_HOURS || '6', 10) || 6
    ) * 60 * 60 * 1000;
    let best = null;
    let bestDelta = Infinity;
    for (const f of candidates) {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        const d = Math.abs(st.mtimeMs - ref.getTime());
        if (d < bestDelta && d <= windowMs) {
          bestDelta = d;
          best = f;
        }
      } catch (_) {
        /* skip */
      }
    }
    if (best) return toVerifiedFull(best);
  }

  return null;
}

module.exports = {
  transcribeFromRecordingUrl,
  transcribeWithOpenAIWhisper,
  transcribeWithCustomHttp,
  executeOpenAITranscriptionV1,
  downloadFile,
  downloadRecordingToBuffer,
  detectAudioFormat,
  getAudioDownloadDir,
  sanitizeBotIdForFilename,
  resolveArchivedRecordingPath,
};
