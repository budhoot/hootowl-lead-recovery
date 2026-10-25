// Voices customers can pick for their AI receptionist (ElevenLabs premade voices, played through Twilio ConversationRelay).
const VOICES = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Female · soft and reassuring' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', description: 'Female · bright and conversational' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Female · warm and friendly' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'Male · deep and steady' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', description: 'Male · casual and down-to-earth' },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', description: 'Male · smooth and friendly' },
];
const DEFAULT_VOICE_ID = VOICES[0].id;

// A customer may choose a listed voice, or keep the voice it already has (for example one HootOwl set up for it).
function isAllowedVoice(voiceId, currentVoiceId) {
  return VOICES.some((voice) => voice.id === voiceId) || (!!currentVoiceId && voiceId === currentVoiceId);
}

module.exports = { DEFAULT_VOICE_ID, VOICES, isAllowedVoice };
