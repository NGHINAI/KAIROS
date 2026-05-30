// SileroVAD.swift — voice activity detection via Silero VAD CoreML model.
//
// The Silero VAD model is a ~5MB MLModel running on the Apple Neural Engine.
// Receives 16kHz mono Float32 buffers, emits a probability (0-1) of human voice
// presence. We threshold at 0.7 to fire `user_speaking_started` events used by
// the BargeInDetector and the listen-mode VAD.
//
// Bundle the model file separately as silero_vad.mlmodelc and load at init.

import Foundation
import AVFoundation
import CoreML

final class SileroVAD {
    private let bus: ProtocolBus
    private var model: MLModel?
    private let threshold: Float = 0.7
    private var lastSpeakingState = false

    private var onSpeechHandler: (() -> Void)?

    init(bus: ProtocolBus) {
        self.bus = bus
        loadModel()
    }

    func onSpeechDetected(_ handler: @escaping () -> Void) {
        onSpeechHandler = handler
    }

    private func loadModel() {
        // Try the bundled resource first, fall back to standard SwiftPM search paths.
        let candidates: [String?] = [
            Bundle.main.path(forResource: "silero_vad", ofType: "mlmodelc"),
        ]
        for candidate in candidates {
            guard let path = candidate else { continue }
            let url = URL(fileURLWithPath: path)
            do {
                model = try MLModel(contentsOf: url)
                return
            } catch {
                NSLog("SileroVAD load failed: \(error)")
            }
        }
        NSLog("SileroVAD model not found — VAD will be a no-op")
    }

    func feed(buffer: AVAudioPCMBuffer) {
        guard let model = model else { return }
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        guard frames >= 512 else { return }

        // Silero expects 512-sample frames at 16kHz. We'll batch what we have.
        do {
            let array = try MLMultiArray(shape: [1, NSNumber(value: frames)], dataType: .float32)
            for i in 0..<frames {
                array[i] = NSNumber(value: channelData[i])
            }
            let input = try MLDictionaryFeatureProvider(dictionary: ["input": MLFeatureValue(multiArray: array)])
            let output = try model.prediction(from: input)
            if let probArr = output.featureValue(for: "output")?.multiArrayValue {
                let prob = probArr[0].floatValue
                let isSpeaking = prob >= threshold
                if isSpeaking && !lastSpeakingState {
                    bus.emit(["event": "user_speaking_started", "amplitude": Double(prob)])
                    onSpeechHandler?()
                }
                lastSpeakingState = isSpeaking
            }
        } catch {
            // VAD failures are non-fatal — just skip this buffer
        }
    }
}
