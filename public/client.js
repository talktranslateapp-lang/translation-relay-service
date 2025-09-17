// Enhanced debugging - check immediately when script loads
console.log('=== CLIENT.JS LOADING ===');
console.log('Twilio object exists:', typeof Twilio !== 'undefined');
console.log('Window.Twilio exists:', typeof window.Twilio !== 'undefined');
console.log('Document ready state:', document.readyState);

if (typeof Twilio !== 'undefined') {
    console.log('Twilio SDK loaded successfully');
    console.log('Twilio.Device available:', typeof Twilio.Device !== 'undefined');
} else {
    console.error('Twilio SDK NOT loaded');
}

// Global variables
let device;
let activeCall;
let currentSession = null;
let isMuted = false;
let translationSocket = null; // WebSocket for translation updates

// DOM elements - will be set when DOM is ready
let startSection;
let joinSection;
let translationDisplay;
let statusDiv;
let statusMessage;
let translationForm;
let startBtn;
let joinCallBtn;
let endCallBtn;
let muteBtn;
let statusText;
let callStatus;
let translationLog;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('=== DOM CONTENT LOADED ===');
    console.log('Twilio available at DOMContentLoaded:', typeof Twilio !== 'undefined');
    
    if (typeof Twilio === 'undefined') {
        console.error('CRITICAL: Twilio still not available after DOMContentLoaded');
        updateStatus('Twilio SDK failed to load. Please check your internet connection and refresh.', 'error');
        return;
    }
    
    console.log('Initializing Phase 2 - Web Calling Interface');
    setupEventListeners();
    initializeTwilioDevice();
});

// Setup event listeners
function setupEventListeners() {
    console.log('Setting up event listeners');
    
    // Get DOM elements when DOM is ready
    startSection = document.getElementById('start-section');
    joinSection = document.getElementById('join-section');
    translationDisplay = document.getElementById('translation-display');
    statusDiv = document.getElementById('status');
    statusMessage = document.getElementById('status-message');
    translationForm = document.getElementById('translation-form');
    startBtn = document.getElementById('start-btn');
    joinCallBtn = document.getElementById('join-call-btn');
    endCallBtn = document.getElementById('end-call-btn');
    muteBtn = document.getElementById('mute-btn');
    statusText = document.getElementById('status-text');
    callStatus = document.getElementById('call-status');
    translationLog = document.getElementById('translation-log');
    
    console.log('DOM elements check:');
    console.log('- Start button:', startBtn);
    console.log('- Translation form:', translationForm);
    
    if (translationForm) {
        translationForm.addEventListener('submit', handleStartTranslation);
        console.log('Form event listener attached');
    } else {
        console.error('Translation form not found');
    }
    
    if (joinCallBtn) {
        joinCallBtn.addEventListener('click', handleJoinCall);
    }
    
    if (endCallBtn) {
        endCallBtn.addEventListener('click', handleEndCall);
    }
    
    if (muteBtn) {
        muteBtn.addEventListener('click', handleToggleMute);
    }
    
    console.log('Event listeners setup complete');
}

// Initialize Twilio Device for web calling
async function initializeTwilioDevice() {
    try {
        console.log('Getting access token...');
        
        // Final check for Twilio availability
        if (typeof Twilio === 'undefined' || !Twilio.Device) {
            throw new Error('Twilio Voice SDK not available');
        }
        
        const response = await fetch('/token');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!data.token) {
            throw new Error('No access token received: ' + (data.error || JSON.stringify(data)));
        }
        
        console.log('Access token received');
        
        // Initialize Twilio Device
        device = new Twilio.Device(data.token, {
            logLevel: 1,
            answerOnBridge: true,
            allowIncomingWhileBusy: true,
            closeProtection: true
        });
        
        // Setup device event handlers
        device.on('ready', () => {
            console.log('Twilio Device ready');
            updateStatus('Voice calling ready! You can now start translation calls.', 'success');
        });
        
        device.on('error', (error) => {
            console.error('Twilio Device error:', error);
            updateStatus(`Device error: ${error.message}`, 'error');
        });
        
        device.on('connect', (call) => {
            console.log('Call connected');
        });
        
        device.on('disconnect', (call) => {
            console.log('Call disconnected');
            handleCallDisconnected();
        });
        
        device.on('incoming', (call) => {
            console.log('Incoming call received');
        });
        
        device.on('tokenWillExpire', async () => {
            console.log('Token expiring, refreshing...');
            try {
                const response = await fetch('/token');
                const data = await response.json();
                device.updateToken(data.token);
                console.log('Token refreshed');
            } catch (error) {
                console.error('Failed to refresh token:', error);
            }
        });
        
    } catch (error) {
        console.error('Failed to initialize Twilio Device:', error);
        updateStatus(`Failed to initialize calling: ${error.message}`, 'error');
    }
}

// Handle start translation form submission with language support
async function handleStartTranslation(e) {
    e.preventDefault();
    
    console.log('Form submission triggered!');
    
    const phoneNumber = document.getElementById('phone-number').value.trim();
    const webLanguage = document.getElementById('web-language').value;
    const phoneLanguage = document.getElementById('phone-language').value;
    
    console.log('Starting translation session:', { phoneNumber, webLanguage, phoneLanguage });
    
    if (!isValidPhoneNumber(phoneNumber)) {
        updateStatus('Please enter a valid phone number with country code (e.g., +1234567890)', 'error');
        return;
    }
    
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = 'Calling...';
    }
    updateStatus('Starting translation session...', 'info');
    
    try {
        console.log('Making API request to /create-session');
        
        // Send language preferences to server
        const response = await fetch('/create-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phoneNumber: phoneNumber,
                phoneLanguage: phoneLanguage,
                webLanguage: webLanguage
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Translation session response:', data);
        
        if (data.success) {
            currentSession = {
                sessionId: data.sessionId,
                callSid: data.callSid,
                languages: {
                    web: webLanguage,
                    phone: phoneLanguage
                }
            };
            
            console.log('Translation session started successfully:', currentSession);
            
            // Show join section
            if (startSection) startSection.classList.add('hidden');
            if (joinSection) joinSection.classList.remove('hidden');
            
            // Initialize translation WebSocket
            initializeTranslationWebSocket();
            
            updateStatus(
                `Call initiated successfully!\n` +
                `The person at ${phoneNumber} should receive a call now.\n` +
                `Translation: ${getLanguageName(webLanguage)} ↔ ${getLanguageName(phoneLanguage)}\n` +
                `Once they answer, click "Join Call" to start translation.`,
                'success'
            );
            
            // Start checking session status
            checkSessionStatus();
            
        } else {
            throw new Error(data.error || 'Failed to start translation session');
        }
        
    } catch (error) {
        console.error('Translation session failed:', error);
        updateStatus(`Failed to start translation: ${error.message}`, 'error');
    } finally {
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = 'Start Translation Call';
        }
    }
}

// Initialize translation WebSocket for real-time updates
function initializeTranslationWebSocket() {
    if (!currentSession) return;
    
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/translation-updates?session=${currentSession.sessionId}`;
        
        translationSocket = new WebSocket(wsUrl);
        
        translationSocket.onopen = () => {
            console.log('Translation WebSocket connected');
        };
        
        translationSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleTranslationUpdate(data);
            } catch (error) {
                console.error('Error parsing translation update:', error);
            }
        };
        
        translationSocket.onclose = () => {
            console.log('Translation WebSocket disconnected');
        };
        
        translationSocket.onerror = (error) => {
            console.error('Translation WebSocket error:', error);
        };
        
    } catch (error) {
        console.error('Failed to initialize translation WebSocket:', error);
    }
}

// Handle translation updates from server
function handleTranslationUpdate(data) {
    console.log('Translation update:', data);
    
    switch (data.type) {
        case 'transcription':
            addTranslationEntry(data.speaker, data.text, null, 'transcribing');
            break;
            
        case 'translation':
            updateTranslationEntry(data.originalText, data.translatedText, data.fromLanguage, data.toLanguage);
            break;
            
        case 'error':
            console.error('Translation error:', data.error);
            addTranslationEntry('System', `Translation error: ${data.error}`, null, 'error');
            break;
            
        default:
            console.log('Unknown translation update type:', data.type);
    }
}

// Add translation entry to the log
function addTranslationEntry(speaker, originalText, translatedText, status = 'completed') {
    if (!translationLog) return;
    
    const timestamp = new Date().toLocaleTimeString();
    const entryId = `entry-${Date.now()}`;
    
    const entryHtml = `
        <div class="translation-item" id="${entryId}" data-status="${status}">
            <span class="speaker">${speaker} (${timestamp}):</span>
            <span class="original">${originalText}</span>
            ${translatedText ? `<span class="translated">${translatedText}</span>` : ''}
            ${status === 'transcribing' ? '<span class="status">Translating...</span>' : ''}
            ${status === 'error' ? '<span class="status error">Error</span>' : ''}
        </div>
    `;
    
    translationLog.insertAdjacentHTML('beforeend', entryHtml);
    translationLog.scrollTop = translationLog.scrollHeight;
}

// Update existing translation entry
function updateTranslationEntry(originalText, translatedText, fromLang, toLang) {
    if (!translationLog) return;
    
    // Find the entry with matching original text
    const entries = translationLog.querySelectorAll('.translation-item[data-status="transcribing"]');
    for (const entry of entries) {
        const originalSpan = entry.querySelector('.original');
        if (originalSpan && originalSpan.textContent === originalText) {
            // Update the entry
            const statusSpan = entry.querySelector('.status');
            if (statusSpan) statusSpan.remove();
            
            entry.insertAdjacentHTML('beforeend', `<span class="translated">${translatedText}</span>`);
            entry.setAttribute('data-status', 'completed');
            break;
        }
    }
}

// Get human-readable language name
function getLanguageName(langCode) {
    const languageNames = {
        'en': 'English',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'zh': 'Chinese',
        'ja': 'Japanese',
        'ko': 'Korean',
        'ar': 'Arabic',
        'hi': 'Hindi',
        'pt': 'Portuguese',
        'ru': 'Russian',
        'it': 'Italian',
        'vi': 'Vietnamese',
        'th': 'Thai'
    };
    return languageNames[langCode] || langCode;
}

// Handle join call button with translation support
async function handleJoinCall() {
    if (!currentSession || !device) {
        updateStatus('No active session or device not ready', 'error');
        return;
    }
    
    try {
        if (joinCallBtn) {
            joinCallBtn.disabled = true;
            joinCallBtn.textContent = 'Connecting...';
        }
        updateCallStatus('connecting', 'Connecting to call...');
        
        console.log('Joining call via Twilio Device');
        
        // Make a call to join the conference
        const params = {
            type: 'web'
        };
        
        console.log('Connecting with params:', params);
        
        activeCall = await device.connect(params);
        
        activeCall.on('accept', () => {
            console.log('Call accepted - joined conference');
            updateCallStatus('connected', 'Connected - Translation Active!');
            
            // Show call controls and translation display
            if (joinCallBtn) joinCallBtn.classList.add('hidden');
            if (endCallBtn) endCallBtn.classList.remove('hidden');
            if (muteBtn) muteBtn.classList.remove('hidden');
            if (translationDisplay) translationDisplay.classList.remove('hidden');
            
            // Clear any existing translation log and add welcome message
            if (translationLog) {
                translationLog.innerHTML = `
                    <div class="translation-item">
                        <span class="speaker">System:</span>
                        <span class="translated">Translation active! Speak naturally and translations will appear here in real-time.</span>
                    </div>
                `;
            }
            
            updateStatus(`Successfully joined! Translation between ${getLanguageName(currentSession.languages.web)} and ${getLanguageName(currentSession.languages.phone)} is now active.`, 'success');
        });
        
        activeCall.on('disconnect', () => {
            console.log('Call disconnected');
            handleCallDisconnected();
        });
        
        activeCall.on('error', (error) => {
            console.error('Call error:', error);
            updateStatus(`Call error: ${error.message}`, 'error');
            handleCallDisconnected();
        });
        
        activeCall.on('cancel', () => {
            console.log('Call cancelled');
            handleCallDisconnected();
        });
        
        activeCall.on('reject', () => {
            console.log('Call rejected');
            updateStatus('Call was rejected', 'error');
            handleCallDisconnected();
        });
        
    } catch (error) {
        console.error('Failed to join call:', error);
        updateStatus(`Failed to join call: ${error.message}`, 'error');
        
        if (joinCallBtn) {
            joinCallBtn.disabled = false;
            joinCallBtn.textContent = 'Join Call via Browser';
        }
        updateCallStatus('error', 'Failed to connect');
    }
}

// Handle end call with translation cleanup
function handleEndCall() {
    console.log('Ending call');
    
    if (activeCall) {
        activeCall.disconnect();
    }
    handleCallDisconnected();
}

// Handle call disconnected with translation cleanup
function handleCallDisconnected() {
    console.log('Handling call disconnect');
    
    activeCall = null;
    
    // Close translation WebSocket
    if (translationSocket) {
        translationSocket.close();
        translationSocket = null;
    }
    
    // Reset UI
    if (joinCallBtn) {
        joinCallBtn.classList.remove('hidden');
        joinCallBtn.disabled = false;
        joinCallBtn.textContent = 'Join Call via Browser';
    }
    
    if (endCallBtn) endCallBtn.classList.add('hidden');
    if (muteBtn) muteBtn.classList.add('hidden');
    
    updateCallStatus('disconnected', 'Call ended');
    updateStatus('Call ended. You can start a new translation session if needed.', 'info');
    
    // Reset mute state
    isMuted = false;
    if (muteBtn) {
        muteBtn.textContent = 'Mute';
        muteBtn.classList.remove('muted');
    }
    
    // Add final message to translation log
    if (translationLog) {
        addTranslationEntry('System', 'Call ended. Translation session complete.', null, 'completed');
    }
}

// Handle mute toggle
function handleToggleMute() {
    if (!activeCall) return;
    
    isMuted = !isMuted;
    activeCall.mute(isMuted);
    
    if (muteBtn) {
        muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
        muteBtn.classList.toggle('muted', isMuted);
    }
    
    console.log(`Call ${isMuted ? 'muted' : 'unmuted'}`);
    
    // Add mute status to translation log
    if (translationLog) {
        addTranslationEntry('System', `Microphone ${isMuted ? 'muted' : 'unmuted'}`, null, 'completed');
    }
}

// Check session status periodically
async function checkSessionStatus() {
    if (!currentSession) return;
    
    try {
        const response = await fetch('/api/sessions');
        const data = await response.json();
        
        // Find our session in the list
        const session = data.find(s => s.sessionId === currentSession.sessionId);
        
        if (session) {
            console.log('Session status:', session.status);
            
            // Update UI based on session status
            if (session.status === 'phone_answered') {
                updateStatus('Phone answered! Ready to join the call.', 'success');
                if (joinCallBtn) joinCallBtn.disabled = false;
            } else if (session.status === 'call_ended') {
                updateStatus('Session ended (phone call failed or completed)', 'error');
                return; // Stop checking
            }
        }
        
        // Check again in 3 seconds
        setTimeout(checkSessionStatus, 3000);
        
    } catch (error) {
        console.error('Failed to check session status:', error);
    }
}

// Update call status indicator
function updateCallStatus(status, message) {
    const statusClasses = {
        'connecting': 'status-connecting',
        'connected': 'status-connected',
        'disconnected': 'status-disconnected',
        'error': 'status-error'
    };
    
    if (callStatus) {
        // Remove all status classes
        Object.values(statusClasses).forEach(className => {
            callStatus.classList.remove(className);
        });
        
        // Add current status class
        if (statusClasses[status]) {
            callStatus.classList.add(statusClasses[status]);
        }
    }
    
    if (statusText) {
        statusText.textContent = message;
    }
    
    console.log(`Call status updated: ${status} - ${message}`);
}

// Utility functions
function isValidPhoneNumber(phone) {
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phone) && phone.length >= 8 && phone.length <= 16;
}

function updateStatus(message, type = 'info') {
    console.log(`Status (${type}):`, message);
    
    if (statusMessage) {
        statusMessage.textContent = message;
    }
    
    if (statusDiv) {
        statusDiv.className = `status ${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
        statusDiv.classList.remove('hidden');
    }
    
    // Auto-hide non-error messages after 10 seconds
    if (type !== 'error') {
        setTimeout(() => {
            if (statusDiv) {
                statusDiv.classList.add('hidden');
            }
        }, 10000);
    }
}

// Handle page visibility changes (cleanup on page close)
document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeCall) {
        console.log('Page hidden - ending call');
        activeCall.disconnect();
    }
});

// Handle browser page unload
window.addEventListener('beforeunload', () => {
    if (activeCall) {
        console.log('Page unloading - ending call');
        activeCall.disconnect();
    }
    
    if (translationSocket) {
        translationSocket.close();
    }
});

// Debugging: Log when script finishes loading
console.log('=== CLIENT.JS LOADED COMPLETELY ===');
console.log('Final Twilio check:', typeof Twilio !== 'undefined');
