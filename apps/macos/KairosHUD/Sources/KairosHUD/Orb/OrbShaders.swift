// OrbShaders.swift — "neural energy ring": an ULTRA-THIN laser-bright ring of condensed light, with
// layered volumetric glow, flowing plasma wisps (FBM), curved orbiting filaments, and sparse sharp
// energy spikes. Runtime-compiled (no Metal toolchain). Premium AI-OS / holographic aesthetic.
//
//  • Ring: laser-thin bright core (condensed energy, not a solid stroke) + a multi-stage glow stack
//    (intense inner glow → bloom → large atmospheric halo).
//  • Filaments: a few thin curved arcs that orbit the ring like magnetic field lines, drifting.
//  • Wisps: domain-warped FBM plasma OUTSIDE the ring, flowing/orbiting (cloud-like trails).
//  • Spikes: sparse, elegant radial beams (solar-flare bursts of "intelligence/audio").
//  • Color: smooth sweep — warm gold / ember orange (top) → turquoise / electric cyan / deep azure
//    (bottom) → subtle violet, blended smoothly around the circumference.
//  • Center: completely empty/transparent. Alive, breathing, pulses with `level` (voice).
//  • State: `mode` sets the ring's shape (breathing → liquid lobes); `level` drives the pulse.

enum OrbShaders {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Uniforms {
        float2 resolution; float time; float level;
        float4 cWarm; float4 cAccent; float4 cCool;
        float4 cRim;    // x=sweepRotation y=flip z=mode w=-
        float4 params;  // x=bloom y=ringRadius z=coreWidth w=rotSpeed
    };
    struct VSOut { float4 pos [[position]]; float2 uv; };

    vertex VSOut v_main(uint vid [[vertex_id]]) {
        float2 p = float2((vid == 2) ? 3.0 : -1.0, (vid == 1) ? 3.0 : -1.0);
        VSOut o; o.pos = float4(p, 0.0, 1.0); o.uv = (p + 1.0) * 0.5; return o;
    }

    static inline float angWrap(float d) { return atan2(sin(d), cos(d)); }

    static inline float hash21(float2 p) {
        p = fract(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y);
    }
    static inline float vnoise(float2 p) {
        float2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i), b = hash21(i + float2(1, 0)), c = hash21(i + float2(0, 1)), d = hash21(i + float2(1, 1));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    static inline float fbm(float2 p) {
        float f = 0.0, amp = 0.5; float2x2 rot = float2x2(0.8, 0.6, -0.6, 0.8);
        for (int i = 0; i < 4; i++) { f += amp * vnoise(p); p = rot * p * 2.02; amp *= 0.5; }
        return f;
    }

    // smooth premium sweep: gold/ember (top) → turquoise/cyan/azure (bottom) → subtle violet
    constant float  kA[6] = { 1.5708, 0.6981, -0.5236, -1.5708, -2.6180, 2.6180 };
    constant float3 kC[6] = {
        float3(1.00, 0.80, 0.35),   // warm gold (top)
        float3(1.00, 0.48, 0.12),   // ember orange
        float3(0.15, 0.95, 0.82),   // glowing turquoise
        float3(0.10, 0.85, 1.00),   // electric cyan
        float3(0.12, 0.40, 1.00),   // deep azure blue
        float3(0.55, 0.45, 0.95)    // subtle violet
    };
    static inline float3 sweep(float ang) {
        const float s2 = 2.0 * 0.85 * 0.85;
        float3 num = float3(0.0); float den = 0.0;
        for (int i = 0; i < 6; i++) { float w = exp(-pow(angWrap(ang - kA[i]), 2.0) / s2); num += kC[i] * w; den += w; }
        return num / den;
    }

    fragment half4 f_main(VSOut in [[stage_in]], constant Uniforms& U [[buffer(0)]]) {
        float2 c = in.uv * 2.0 - 1.0; c.x *= U.resolution.x / U.resolution.y;
        float r = length(c); float ang = atan2(c.y, c.x);
        float t = U.time, level = U.level;
        float flip = (U.cRim.y == 0.0) ? 1.0 : U.cRim.y;
        float baseAng = U.cRim.x;
        float bloom = U.params.x, ringR = U.params.y, coreW = U.params.z, rotSpeed = U.params.w;
        float gA = flip * ang + baseAng + t * rotSpeed;       // sweep lookup angle

        // DISTINCT per-state motion, blended from archetypes (each weight eased on the CPU so states
        // cross-fade). amp/spd scale the whole thing; the weights pick the CHARACTER:
        //   breathe = slow uniform swell (idle) · pulse = faster uniform (listening) ·
        //   travel  = a wave running AROUND the ring (thinking) · lobe = voice-driven lobes (speaking) ·
        //   jitter  = agitated high-freq shake (error).
        float amp = U.cWarm.x;
        float spd = U.cWarm.y;
        float wBreathe = U.cAccent.x, wPulse = U.cAccent.y, wTravel = U.cAccent.z, wLobe = U.cAccent.w;
        float wJitter = U.cCool.x;

        float a_breathe = sin(t * 0.85 * spd);                                  // uniform, slow
        float a_pulse   = sin(t * 1.8 * spd);                                   // uniform, faster
        float a_travel  = sin(3.0 * ang - t * 1.7 * spd);                       // bump travels around ring
        float a_lobe    = (0.62 * sin(2.0 * ang + t * 0.9 * spd)
                          + 0.38 * sin(3.0 * ang - t * 0.7 * spd)) * (0.45 + 1.7 * level); // voice lobes
        float a_jitter  = sin(11.0 * ang + t * 6.5) * 0.55
                          + (vnoise(float2(ang * 4.0, t * 7.0)) - 0.5) * 1.1;   // shaky

        float disp = wBreathe * a_breathe + wPulse * a_pulse + wTravel * a_travel
                   + wLobe * a_lobe + wJitter * a_jitter;
        float rs = ringR * (1.0 + amp * disp + 0.025 * level);   // small live baseline swell while speaking

        // flares (wisps/filaments/spikes) fade in with overall activity — clean ring at idle
        float energy = clamp(amp * 8.0 + level * 0.7 + (wTravel + wLobe + wJitter) * 0.12, 0.05, 1.0);
        float d = r - rs;                                     // signed distance to the ring
        float3 acc = float3(0.0); float white = 0.0;
        float3 col = sweep(gA);

        // (1) ULTRA-THIN ring core (condensed light) — 2 nearly-coincident strands for a hint of weave
        for (int s = 0; s < 2; s++) {
            float off = (float(s) - 0.5) * 0.010;
            float weave = 0.008 * sin(5.0 * ang - t * (0.6 * spd + 0.5) + float(s) * 3.0);
            float ds = d - ringR * (off + weave);
            float core = exp(-pow(ds / coreW, 2.0));
            white += core;
            acc += sweep(gA + float(s) * 0.12) * core * 2.2;
        }

        // (2) layered glow stack off the ring edge
        float innerGlow = exp(-pow(d / (coreW * 5.0),  2.0)) * 0.70;   // intense inner glow
        float bloom1    = exp(-pow(d / (coreW * 16.0), 2.0)) * 0.30;   // strong bloom
        float halo      = exp(-pow(d / (coreW * 55.0), 2.0)) * 0.10;   // large atmospheric halo
        acc += col * (innerGlow + bloom1 + halo);

        // (3) flowing plasma WISPS — domain-warped FBM OUTSIDE the ring, orbiting
        float outward = smoothstep(0.0, coreW * 6.0, d);              // only outside the ring
        float falloff = exp(-pow(max(0.0, d) / (ringR * 0.55), 2.0)); // fade into darkness
        float pa = ang * 2.0 + t * 0.30;
        float pr = (r - ringR) * 3.2 - t * 0.45;
        float n = fbm(float2(pa, pr) + 1.7 * fbm(float2(pa * 0.6 + t * 0.1, pr * 0.6)));
        n = pow(max(0.0, n), 1.6);
        acc += col * n * outward * falloff * (0.55 + level * 0.6) * energy;

        // (4) curved orbiting FILAMENTS — thin arcs that wander out and drift around the ring
        for (int f = 0; f < 2; f++) {
            float ff = float(f);
            float filR = ringR * (1.0 + 0.05 + 0.045 * ff + 0.05 * sin(3.0 * ang + t * (0.7 + 0.3 * ff) + ff * 2.1));
            float dF = r - filR;
            float win = smoothstep(0.25, 0.85, 0.5 + 0.5 * sin(ang * 1.0 - t * (0.5 + 0.2 * ff) + ff * 3.0));
            acc += sweep(gA + ff * 0.4) * exp(-pow(dF / (coreW * 3.0), 2.0)) * win * 0.45 * energy;
        }

        // (5) sparse sharp SPIKES — elegant radial beams (occasional bursts), reactive to level
        for (int k = 0; k < 3; k++) {
            float ka = float(k) * 2.0944 + t * 0.35;
            float burst = smoothstep(0.55, 1.0, 0.5 + 0.5 * sin(t * 1.3 + float(k) * 2.3));
            float dA = angWrap(ang - ka);
            float beam = exp(-pow(dA / 0.05, 2.0)) * outward * exp(-pow(max(0.0, d) / (ringR * 0.8), 2.0));
            acc += sweep(flip * ka + baseAng) * beam * burst * (0.35 + level * 0.7) * energy;
        }

        white = clamp(white, 0.0, 1.0);
        acc += float3(1.0) * white * 0.6;          // white-hot condensed core
        acc *= bloom * (0.9 + level * 0.5);
        acc = 1.0 - exp(-acc * 2.4);               // physically-soft tone-map
        float a = clamp(dot(acc, float3(0.30, 0.59, 0.11)) * 1.7 + white * 0.3, 0.0, 1.0);
        return half4(half3(acc * a), half(a));      // premultiplied; empty transparent center
    }
    """
}
