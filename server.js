import express from 'express';
import twilio from 'twilio';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse.js';
import { WebSocketServer } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory storage for active sessions
const activeSessions = new Map();
const activeStreams = new Map(); // Track media streams

// Twilio client
const client = twilio();

// OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Audio processing configuration
const AUDIO_CONFIG = {
    sampleRate: 8000,
    channels: 1,
    bitDepth: 16,
    chunkSize: 1600, // 200ms at 8kHz
};

// Language configuration
const SUPPORTED_LANGUAGES = {
    'en': 'en-US',
    'es': 'es-ES', 
    'fr': 'fr-FR',
    'de': 'de-DE',
    'zh': 'zh-CN',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
    'ar': 'ar-SA',
    'hi': 'hi-IN',
    'pt': 'pt-BR',
    'ru': 'ru-RU',
    'it': 'it-IT',
    'vi': 'vi-VN',
    'th': 'th-TH'
};

// Static files
app.use(express.static('public'));

// Root route
app.get('/', (req, res) => {
    res.send(`
        <h1>Real-time Translation Relay Service</h1>
        <p>Service is running on port ${process.env.PORT || 3000}</p>
        <p>Active sessions: ${activeSessions.size}</p>
        <ul>
            <li><a href="/web-call">Web Call Interface</a></li>
        </ul>
    `);
});

// Web call interface
app.get('/web-call', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Web Call Interface</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .btn { background: #007bff; color: white; border: none; padding: 10px 20px; cursor: pointer; margin: 5px; border-radius: 5px; }
        .btn:hover { background: #0056b3; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .status { margin: 20px 0; padding: 10px; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
    </style>
</head>
<body>
    <h1>Web Call Interface</h1>
    
    <div id="status" class="status info">Ready to connect</div>
    
    <div>
        <button id="startCall" class="btn">Start Call</button>
        <button id="endCall" class="btn" disabled>End Call</button>
    </div>
    
    <div>
        <h3>Active Sessions:</h3>
        <div id="activeSessions">Loading...</div>
    </div>

    <script src="//sdk.twilio.com/js/client/releases/1.14.1/twilio.min.js"></script>
    <script>
        let device;
        let connection;
        
        const statusDiv = document.getElementById('status');
        const startBtn = document.getElementById('startCall');
        const endBtn = document.getElementById('endCall');
        
        function updateStatus(message, type = 'info') {
            statusDiv.textContent = message;
            statusDiv.className = 'status ' + type;
        }
        
        // Initialize Twilio Device
        async function initializeDevice() {
            try {
                updateStatus('Getting access token...', 'info');
                const response = await fetch('/token');
                const data = await response.json();
                
                if (data.error) {
                    throw new Error(data.error);
                }
                
                device = new Twilio.Device(data.token, {
                    logLevel: 1,
                    codecPreferences: ['opus', 'pcmu']
                });
                
                device.ready(() => {
                    updateStatus('Ready to make calls', 'success');
                    startBtn.disabled = false;
                });
                
                device.error((error) => {
                    updateStatus('Device Error: ' + error.message, 'error');
                    console.error('Device error:', error);
                });
                
                device.connect((conn) => {
                    updateStatus('Connected to call', 'success');
                    connection = conn;
                    startBtn.disabled = true;
                    endBtn.disabled = false;
                });
                
                device.disconnect((conn) => {
                    updateStatus('Call ended', 'info');
                    connection = null;
                    startBtn.disabled = false;
                    endBtn.disabled = true;
                });
                
            } catch (error) {
                updateStatus('Failed to initialize: ' + error.message, 'error');
                console.error('Initialization error:', error);
            }
        }
        
        startBtn.addEventListener('click', () => {
            if (device) {
                updateStatus('Connecting...', 'info');
                connection = device.connect({ 'type': 'web' });
            }
        });
        
        endBtn.addEventListener('click', () => {
            if (connection) {
                connection.disconnect();
            }
        });
        
        // Load active sessions
        async function loadActiveSessions() {
            try {
                const response = await fetch('/api/sessions');
                const sessions = await response.json();
                const container = document.getElementById('activeSessions');
                
                if (sessions.length === 0) {
                    container.innerHTML = '<p>No active sessions</p>';
                } else {
                    container.innerHTML = sessions.map(session => 
                        '<div style="border: 1px solid #ccc; padding: 10px; margin: 5px; border-radius: 5px;">' +
                        '<strong>Session:</strong> ' + session.sessionId + '<br>' +
                        '<strong>Status:</strong> ' + session.status + '<br>' +
                        '<strong>Created:</strong> ' + new Date(session.createdAt).toLocaleString() + '<br>' +
                        '<strong>Phone:</strong> ' + (session.phoneNumber || 'Not set') +
                        '</div>'
                    ).join('');
                }
            } catch (error) {
                document.getElementById('activeSessions').innerHTML = '<p>Error loading sessions</p>';
            }
        }
        
        // Initialize everything
        initializeDevice();
        loadActiveSessions();
        
        // Refresh sessions every 5 seconds
        setInterval(loadActiveSessions, 5000);
    </script>
</body>
</html>
    `);
});

// Get access token for web calling
app.get('/token', (req, res) => {
    try {
        const AccessToken = twilio.jwt.AccessToken;
        const VoiceGrant = AccessToken.VoiceGrant;
        
        const token = new AccessToken(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_API_KEY,
            process.env.TWILIO_API_SECRET,
            { identity: 'web-client-' + Math.random().toString(36).substr(2, 9) }
        );
        
        const voiceGrant = new VoiceGrant({
            outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
            incomingAllow: false
        });
        
        token.addGrant(voiceGrant);
        
        res.json({
            token: token.toJwt(),
            identity: token.identity
        });
    } catch (error) {
        console.error('Token generation error:', error);
        res.status(500).json({ 
            error: 'Failed to generate token: ' + error.message 
        });
    }
});

// API endpoint to get active sessions
app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.values()).map(session => ({
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt,
        phoneNumber: session.phoneNumber,
        languages: session.languages,
        participants: Object.keys(session.participants || {})
    }));
    
    res.json(sessions);
});

// Create new translation session
app.post('/create-session', async (req, res) => {
    try {
        const { phoneNumber, phoneLanguage = 'es', webLanguage = 'en' } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }
        
        // Validate languages
        if (!SUPPORTED_LANGUAGES[phoneLanguage] || !SUPPORTED_LANGUAGES[webLanguage]) {
            return res.status(400).json({ error: 'Unsupported language' });
        }
        
        const sessionId = uuidv4();
        const conferenceId = 'translation-' + sessionId;
        
        // Store session info with language preferences
        activeSessions.set(sessionId, {
            sessionId,
            conferenceId,
            phoneNumber,
            languages: {
                phone: phoneLanguage,
                web: webLanguage
            },
            status: 'created',
            createdAt: new Date().toISOString(),
            participants: {},
            audioBuffers: new Map() // Store audio for each participant
        });
        
        console.log(`Created translation session ${sessionId} for phone ${phoneNumber}`);
        console.log(`Languages: Phone=${phoneLanguage}, Web=${webLanguage}`);
        
        // Make the call to the phone number
        const call = await client.calls.create({
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: `https://${req.get('host')}/incoming-call?session=${sessionId}&type=phone`,
            statusCallback: `https://${req.get('host')}/call-status?session=${sessionId}`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });
        
        // Update session with call SID
        activeSessions.get(sessionId).callSid = call.sid;
        activeSessions.get(sessionId).status = 'phone_calling';
        
        res.json({
            success: true,
            sessionId,
            callSid: call.sid,
            message: `Calling ${phoneNumber}... Translation will begin when both parties join.`
        });
        
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session: ' + error.message });
    }
});

// Conference-based webhook handler with bidirectional media streams
function handleIncomingCall(req, res) {
    console.log('Incoming call from:', req.body.From);
    console.log('Request query params:', req.query);
    
    const sessionId = req.query.session;
    const participantType = req.query.type || 'phone';
    
    // Handle web calling - check if this is a web client call without session info
    if (participantType === 'web' && !sessionId && req.body.From && req.body.From.startsWith('client:')) {
        console.log('Web caller without session - finding active session...');
        
        const activeSessionsArray = Array.from(activeSessions.values());
        const recentSession = activeSessionsArray
            .filter(s => s.status === 'phone_answered' || s.status === 'phone_calling')
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        
        if (recentSession) {
            console.log(`Web caller joining most recent active session: ${recentSession.sessionId}`);
            return handleWebCallWithSession(req, res, recentSession);
        } else {
            console.log('No active sessions found for web caller');
            const response = new VoiceResponse();
            response.say('No active translation session found. Please start a new session.');
            response.hangup();
            return res.type('text/xml').send(response.toString());
        }
    }
    
    // Handle phone calls with session
    if (!sessionId || !activeSessions.has(sessionId)) {
        console.log('No valid session found for sessionId:', sessionId);
        const response = new VoiceResponse();
        response.say('Sorry, this session is not available. Please try again.');
        response.hangup();
        return res.type('text/xml').send(response.toString());
    }
    
    const session = activeSessions.get(sessionId);
    const response = new VoiceResponse();
    
    console.log(`${participantType} participant joining conference with translation: ${session.conferenceId}`);
    
    // Use Connect Stream for bidirectional audio
    const connect = response.connect();
    connect.stream({
        url: `wss://${req.get('host')}/media-stream?session=${sessionId}&participant=${participantType}`,
        track: 'both_tracks'
    });
    
    // Also join the conference
    const dial = response.dial();
    dial.conference(session.conferenceId, {
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        waitUrl: participantType === 'phone' ? 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.ambient' : '',
        maxParticipants: 10,
        record: false,
        statusCallback: `https://${req.get('host')}/conference-status?session=${sessionId}&participant=${participantType}`,
        statusCallbackEvent: ['start', 'end', 'join', 'leave'],
        statusCallbackMethod: 'POST'
    });
    
    // Update session with participant info
    session.participants[participantType] = {
        callSid: req.body.CallSid,
        from: req.body.From,
        to: req.body.To,
        joinedAt: new Date()
    };
    
    res.type('text/xml').send(response.toString());
}

// Helper function for web calls with session
function handleWebCallWithSession(req, res, session) {
    const response = new VoiceResponse();
    
    console.log(`Web participant joining conference with translation: ${session.conferenceId}`);
    
    // Add bidirectional media stream
    const connect = response.connect();
    connect.stream({
        url: `wss://${req.get('host')}/media-stream?session=${session.sessionId}&participant=web`,
        track: 'both_tracks'
    });
    
    const dial = response.dial();
    dial.conference(session.conferenceId, {
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        waitUrl: '',
        statusCallback: `https://${req.get('host')}/conference-status?session=${session.sessionId}&participant=web`,
        statusCallbackEvent: ['start', 'end', 'join', 'leave'],
        statusCallbackMethod: 'POST'
    });
    
    session.participants.web = {
        callSid: req.body.CallSid,
        from: req.body.From,
        to: req.body.To,
        joinedAt: new Date()
    };
    
    session.status = 'web_joining';
    
    return res.type('text/xml').send(response.toString());
}

// Handle web calls from Voice SDK - UPDATED for translation
function handleWebCall(req, res) {
    console.log('Web call initiated');
    console.log('Request body:', req.body);
    console.log('Query params:', req.query);
    
    const response = new VoiceResponse();
    
    // Check if there are any active sessions the web caller can join
    const activeSessionsArray = Array.from(activeSessions.values());
    const availableSession = activeSessionsArray.find(s => 
        s.status === 'phone_answered' || s.status === 'phone_calling'
    );
    
    if (availableSession) {
        console.log(`Web caller joining session with translation: ${availableSession.sessionId}`);
        
        // ADD MEDIA STREAM for translation - THIS IS THE KEY FIX
        const connect = response.connect();
        connect.stream({
            url: `wss://${req.get('host')}/media-stream?session=${availableSession.sessionId}&participant=web`,
            track: 'both_tracks'
        });
        
        // Join the existing conference
        const dial = response.dial();
        dial.conference(availableSession.conferenceId, {
            startConferenceOnEnter: true,
            endConferenceOnExit: false,
            waitUrl: '',
            statusCallback: `https://${req.get('host')}/conference-status?session=${availableSession.sessionId}&participant=web`,
            statusCallbackEvent: ['start', 'end', 'join', 'leave'],
            statusCallbackMethod: 'POST'
        });
        
        // Update session status
        availableSession.status = 'web_joining';
        availableSession.participants = availableSession.participants || {};
        availableSession.participants.web = {
            callSid: req.body.CallSid,
            from: req.body.From,
            joinedAt: new Date()
        };
        
    } else {
        console.log('No active sessions available for web caller');
        response.say('No active translation session found. Please ask someone to start a phone session first.');
        response.hangup();
    }
    
    console.log('TwiML Response with translation:', response.toString());
    res.type('text/xml').send(response.toString());
}

// Route handlers
app.post('/incoming-call', handleIncomingCall);
app.post('/voice', handleWebCall);

// Call status webhook
app.post('/call-status', (req, res) => {
    const { CallSid, CallStatus, From, To } = req.body;
    const sessionId = req.query.session;
    
    console.log(`Call status update: ${CallStatus} for session ${sessionId}`);
    console.log('Status details:', { CallSid, CallStatus, From, To });
    
    if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        session.lastCallStatus = CallStatus;
        session.lastStatusUpdate = new Date().toISOString();
        
        // Update session status based on call status
        if (CallStatus === 'answered') {
            session.status = 'phone_answered';
        } else if (CallStatus === 'completed' || CallStatus === 'failed') {
            session.status = 'call_ended';
        }
        
        console.log(`Updated session ${sessionId} status to: ${session.status}`);
    }
    
    res.sendStatus(200);
});

// Conference status webhook
app.post('/conference-status', (req, res) => {
    const { ConferenceSid, StatusCallbackEvent, ParticipantLabel } = req.body;
    const sessionId = req.query.session;
    const participantType = req.query.participant;
    
    console.log(`Conference event: ${StatusCallbackEvent} for ${participantType} in session ${sessionId}`);
    console.log('Conference details:', req.body);
    
    if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        
        switch (StatusCallbackEvent) {
            case 'participant-join':
                console.log(`${participantType} joined conference ${ConferenceSid}`);
                if (participantType === 'web') {
                    session.status = 'web_joined';
                } else if (participantType === 'phone') {
                    session.status = 'phone_in_conference';
                }
                break;
                
            case 'participant-leave':
                console.log(`${participantType} left conference ${ConferenceSid}`);
                if (session.participants && session.participants[participantType]) {
                    session.participants[participantType].leftAt = new Date();
                }
                break;
                
            case 'conference-start':
                console.log(`Conference ${ConferenceSid} started`);
                session.status = 'conference_active';
                break;
                
            case 'conference-end':
                console.log(`Conference ${ConferenceSid} ended`);
                session.status = 'conference_ended';
                // Clean up session after a delay
                setTimeout(() => {
                    activeSessions.delete(sessionId);
                    console.log(`Cleaned up session ${sessionId}`);
                }, 60000); // 1 minute delay
                break;
        }
        
        console.log(`Session ${sessionId} status: ${session.status}`);
    }
    
    res.sendStatus(200);
});

// WebSocket server for Media Streams
wss.on('connection', (ws, req) => {
    console.log('WebSocket connection established');
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('session');
    const participant = url.searchParams.get('participant');
    
    if (req.url.includes('/media-stream')) {
        console.log(`Media stream connected for session ${sessionId}, participant ${participant}`);
        handleMediaStream(ws, sessionId, participant);
    } else {
        handleRegularWebSocket(ws);
    }
});

// Handle Media Stream WebSocket for translation
function handleMediaStream(ws, sessionId, participant) {
    let streamSid = null;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        console.error(`No session found for ${sessionId}`);
        ws.close();
        return;
    }
    
    // Store stream reference
    const streamKey = `${sessionId}-${participant}`;
    activeStreams.set(streamKey, { ws, participant, sessionId });
    
    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);
            
            switch (msg.event) {
                case 'connected':
                    console.log(`Media stream connected: ${msg.streamSid}`);
                    streamSid = msg.streamSid;
                    break;
                    
                case 'start':
                    console.log(`Media stream started for ${participant}`);
                    break;
                    
                case 'media':
                    // Process audio for translation
                    await processAudioForTranslation(msg, participant, session, ws);
                    break;
                    
                case 'stop':
                    console.log(`Media stream stopped: ${msg.streamSid}`);
                    activeStreams.delete(streamKey);
                    break;
            }
        } catch (error) {
            console.error('Error processing media stream message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`Media stream disconnected for ${participant}`);
        activeStreams.delete(streamKey);
    });
}

// Handle regular WebSocket connections
function handleRegularWebSocket(ws) {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('WebSocket message:', data);
            
            switch (data.type) {
                case 'join-session':
                    break;
                case 'audio-data':
                    break;
                default:
                    console.log('Unknown WebSocket message type:', data.type);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
}

// Process audio for translation
async function processAudioForTranslation(mediaMsg, participant, session, senderWs) {
    try {
        const audioPayload = mediaMsg.media.payload;
        const audioData = Buffer.from(audioPayload, 'base64');
        
        // Buffer audio until we have enough for processing
        const bufferKey = `${session.sessionId}-${participant}`;
        if (!session.audioBuffers.has(bufferKey)) {
            session.audioBuffers.set(bufferKey, Buffer.alloc(0));
        }
        
        let buffer = session.audioBuffers.get(bufferKey);
        buffer = Buffer.concat([buffer, audioData]);
        
        // Process when we have enough audio (200ms worth)
        if (buffer.length >= AUDIO_CONFIG.chunkSize) {
            const audioToProcess = buffer.slice(0, AUDIO_CONFIG.chunkSize);
            const remainingBuffer = buffer.slice(AUDIO_CONFIG.chunkSize);
            session.audioBuffers.set(bufferKey, remainingBuffer);
            
            // Convert and translate audio
            await translateAndForwardAudio(audioToProcess, participant, session);
        } else {
            session.audioBuffers.set(bufferKey, buffer);
        }
        
    } catch (error) {
        console.error('Error processing audio:', error);
    }
}

// Main translation pipeline
async function translateAndForwardAudio(audioData, sourceParticipant, session) {
    try {
        // Determine source and target languages
        const sourceLanguage = sourceParticipant === 'phone' ? session.languages.phone : session.languages.web;
        const targetLanguage = sourceParticipant === 'phone' ? session.languages.web : session.languages.phone;
        
        // Skip translation if same language
        if (sourceLanguage === targetLanguage) {
            console.log('Same language, skipping translation');
            return;
        }
        
        console.log(`Translating from ${sourceLanguage} to ${targetLanguage}`);
        
        // Step 1: Convert mulaw to wav for OpenAI
        const wavAudio = await convertMulawToWav(audioData);
        
        // Step 2: Speech-to-text with Whisper
        const transcription = await transcribeAudio(wavAudio, sourceLanguage);
        
        if (!transcription || transcription.trim().length === 0) {
            console.log('No speech detected, skipping');
            return;
        }
        
        console.log(`Transcribed (${sourceLanguage}): ${transcription}`);
        
        // Step 3: Translate text
        const translation = await translateText(transcription, sourceLanguage, targetLanguage);
        console.log(`Translated (${targetLanguage}): ${translation}`);
        
        // Step 4: Text-to-speech
        const translatedAudio = await synthesizeSpeech(translation, targetLanguage);
        
        // Step 5: Convert back to mulaw and send to other participant
        const mulawAudio = await convertWavToMulaw(translatedAudio);
        await sendAudioToParticipant(mulawAudio, sourceParticipant === 'phone' ? 'web' : 'phone', session);
        
    } catch (error) {
        console.error('Translation pipeline error:', error);
    }
}

// Audio conversion functions
async function convertMulawToWav(mulawData) {
    // Convert mulaw to linear PCM
    const wavBuffer = Buffer.alloc(mulawData.length * 2);
    for (let i = 0; i < mulawData.length; i++) {
        const sample = mulawData[i];
        const linear = mulawToLinear(sample);
        wavBuffer.writeInt16LE(linear, i * 2);
    }
    return wavBuffer;
}

async function convertWavToMulaw(wavData) {
    // Convert linear PCM back to mulaw
    const mulawBuffer = Buffer.alloc(wavData.length / 2);
    for (let i = 0; i < mulawBuffer.length; i++) {
        const linear = wavData.readInt16LE(i * 2);
        mulawBuffer[i] = linearToMulaw(linear);
    }
    return mulawBuffer;
}

// Simplified mulaw conversion
function mulawToLinear(mulaw) {
    const bias = 0x84;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    let sample = mantissa << (exponent + 3);
    if (exponent !== 0) sample += bias << exponent;
    return sign ? -sample : sample;
}

function linearToMulaw(linear) {
    const bias = 0x84;
    let sample = Math.abs(linear);
    const sign = linear < 0 ? 0x80 : 0;
    
    sample += bias;
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
        if (sample <= (0x1F << (exp + 3))) {
            exponent = exp;
            break;
        }
    }
    
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
}

// OpenAI integration functions
async function transcribeAudio(audioBuffer, language) {
    try {
        // Save temporary WAV file for Whisper
        const tempFile = `/tmp/audio-${Date.now()}.wav`;
        fs.writeFileSync(tempFile, audioBuffer);
        
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFile),
            model: 'whisper-1',
            language: language,
            response_format: 'text'
        });
        
        // Clean up temp file
        fs.unlinkSync(tempFile);
        
        return transcription;
    } catch (error) {
        console.error('Transcription error:', error);
        return null;
    }
}

async function translateText(text, fromLang, toLang) {
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator. Translate the following text from ${fromLang} to ${toLang}. Only respond with the translation, no explanations.`
                },
                {
                    role: 'user',
                    content: text
                }
            ],
            max_tokens: 150,
            temperature: 0.3
        });
        
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error('Translation error:', error);
        return text; // Return original if translation fails
    }
}

async function synthesizeSpeech(text, language) {
    try {
        const response = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'alloy',
            input: text,
            response_format: 'wav'
        });
        
        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer;
    } catch (error) {
        console.error('Speech synthesis error:', error);
        throw error;
    }
}

// Send translated audio to participant
async function sendAudioToParticipant(audioData, targetParticipant, session) {
    try {
        const streamKey = `${session.sessionId}-${targetParticipant}`;
        const stream = activeStreams.get(streamKey);
        
        if (!stream) {
            console.log(`No active stream for ${targetParticipant}`);
            return;
        }
        
        const base64Audio = audioData.toString('base64');
        const mediaMessage = {
            event: 'media',
            streamSid: `stream-${session.sessionId}-${targetParticipant}`,
            media: {
                payload: base64Audio
            }
        };
        
        if (stream.ws.readyState === 1) { // WebSocket.OPEN
            stream.ws.send(JSON.stringify(mediaMessage));
            console.log(`Sent translated audio to ${targetParticipant}`);
        }
    } catch (error) {
        console.error('Error sending audio:', error);
    }
}

// Translation updates WebSocket endpoint
app.get('/translation-updates', (req, res) => {
    res.status(200).send('Translation updates WebSocket endpoint');
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size,
        activeStreams: activeStreams.size,
        uptime: process.uptime()
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Translation relay server running on port ${PORT}`);
    console.log(`📱 Webhook URL: https://your-domain.com/incoming-call`);
    console.log(`🌐 Web interface: https://your-domain.com/web-call`);
    console.log(`🤖 OpenAI integration: ${openai ? 'Ready' : 'Not configured'}`);
});