// src/daemon/voice/types.ts
// Shared types for Phase E.1 voice. Single source of truth — sidecar protocol
// (§5.1.3 of the spec) is defined exactly once here and reused by both the
// simulator (Bun side) and the Swift sidecar implementation (when xcodebuilt).

export type SpeechRate = number  // 0.0–1.0 (Apple) or words-per-minute (say -r)

export type VoiceEvent =
  | { kind: 'user.utterance';      text: string; conversationId: string; at: number }
  | { kind: 'agent.utterance';     text: string; conversationId: string; speakId: string; at: number; proactive?: boolean }
  | { kind: 'agent.interrupted';   speakId: string | null; at: number }
  | { kind: 'hotkey.down';         at: number }
  | { kind: 'hotkey.up';           at: number }
  | { kind: 'session.started';     conversationId: string; at: number }
  | { kind: 'session.ended';       conversationId: string; at: number }

export type SidecarCmd =
  | { cmd: 'speak';            text: string; voice?: string; rate?: SpeechRate; interruptible?: boolean; speakId?: string }
  | { cmd: 'stop_speaking' }
  | { cmd: 'start_listening';  mode: 'push_to_talk' | 'toggle' }
  | { cmd: 'stop_listening' }
  | { cmd: 'set_hotkey';       modifier: 'option' | 'control' | 'command'; action: 'hold' | 'double_tap' }
  | { cmd: 'set_voice';        voice: string }
  | { cmd: 'get_voices' }
  | { cmd: 'health_check' }
  | { cmd: 'shutdown' }

export type SidecarEvent =
  | { event: 'sidecar_ready';        version: string }
  | { event: 'hotkey';               state: 'down' | 'up'; modifier: string }
  | { event: 'stt_partial';          text: string; confidence: number }
  | { event: 'stt_final';            text: string; confidence: number }
  | { event: 'user_speaking_started'; amplitude: number }
  | { event: 'barge_in_detected';    during_speak_id?: string }
  | { event: 'speak_started';        speak_id: string }
  | { event: 'speak_finished';       speak_id: string; interrupted: false }
  | { event: 'speak_interrupted';    speak_id: string }
  | { event: 'voices_available';     voices: { id: string; name: string; quality: string; language: string }[] }
  | { event: 'audio_blob';           wavBase64: string }
  | { event: 'error';                code: string; message?: string }
