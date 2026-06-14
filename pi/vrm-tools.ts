// pi extension — the ONLY way the Aria character affects the world.
// Exposes four SEMANTIC tools that POST to the local VRM API. No raw bone
// rotation, no morph targets, no shell, no arbitrary HTTP is exposed.
// Loaded with:  pi -e pi/vrm-tools.ts --no-builtin-tools \
//                  -t vrm_say,vrm_expression,vrm_motion,vrm_reset
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const BASE_URL = process.env.VRM_BASE_URL ?? "http://127.0.0.1:8970";

async function postJson(path: string, body: unknown): Promise<string> {
  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new Error(`POST ${url} failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vrm_say",
    label: "VRM Say",
    description: "Make the VRM avatar speak the given line out loud.",
    promptSnippet: "Make the VRM avatar say a line out loud",
    parameters: Type.Object({
      text: Type.String({ description: "The short line the avatar should say" }),
    }),
    async execute(_id, params) {
      const out = await postJson("/vrm/say", { text: params.text });
      return {
        content: [{ type: "text", text: `Said: ${params.text}` }],
        details: { tool: "vrm_say", request: params, response: out },
      };
    },
  });

  pi.registerTool({
    name: "vrm_expression",
    label: "VRM Expression",
    description: "Set the VRM avatar's facial expression / emotion.",
    promptSnippet: "Set the VRM avatar's facial expression",
    parameters: Type.Object({
      emotion: StringEnum(
        ["neutral", "happy", "angry", "sad", "relaxed", "surprised"] as const,
        { description: "Emotion preset to apply" },
      ),
    }),
    async execute(_id, params) {
      const out = await postJson("/vrm/expression", { emotion: params.emotion });
      return {
        content: [{ type: "text", text: `Expression set to ${params.emotion}` }],
        details: { tool: "vrm_expression", request: params, response: out },
      };
    },
  });

  pi.registerTool({
    name: "vrm_motion",
    label: "VRM Motion",
    description: "Play a named body gesture on the VRM avatar.",
    promptSnippet: "Play a body gesture on the VRM avatar",
    parameters: Type.Object({
      motion: StringEnum(["wave", "nod"] as const, {
        description: "Gesture to play",
      }),
    }),
    async execute(_id, params) {
      const out = await postJson("/vrm/motion", { motion: params.motion });
      return {
        content: [{ type: "text", text: `Playing motion ${params.motion}` }],
        details: { tool: "vrm_motion", request: params, response: out },
      };
    },
  });

  pi.registerTool({
    name: "vrm_reset",
    label: "VRM Reset",
    description: "Reset the VRM avatar to its neutral pose and expression.",
    promptSnippet: "Reset the VRM avatar to neutral",
    parameters: Type.Object({}),
    async execute() {
      const out = await postJson("/vrm/reset", {});
      return {
        content: [{ type: "text", text: "Avatar reset to neutral." }],
        details: { tool: "vrm_reset", response: out },
      };
    },
  });

  pi.registerTool({
    name: "vrm_action",
    label: "VRM Action",
    description: "Play a named, blendable character action (gesture/pose) on the avatar, with optional intensity and duration. Actions blend in/out and can overlap with idle life.",
    promptSnippet: "Play a named character action on the VRM avatar",
    parameters: Type.Object({
      name: StringEnum(
        ["wave", "happy_wave", "nod", "small_nod", "thinking", "surprised_recoil", "sad_slump", "sleepy_relax"] as const,
        { description: "Which action to play" },
      ),
      intensity: Type.Optional(Type.Number({ description: "0..1 strength", minimum: 0, maximum: 1 })),
      durationMs: Type.Optional(Type.Number({ description: "Override the action's duration, in ms" })),
    }),
    async execute(_id, params) {
      const out = await postJson("/vrm/action", params);
      return {
        content: [{ type: "text", text: `Playing action ${params.name}` }],
        details: { tool: "vrm_action", request: params, response: out },
      };
    },
  });

  pi.registerTool({
    name: "vrm_mood",
    label: "VRM Mood",
    description: "Set the avatar's emotional mood (affect). It biases expressions over time and decays naturally, so the face doesn't snap between states.",
    promptSnippet: "Set the VRM avatar's mood",
    parameters: Type.Object({
      mood: StringEnum(
        ["happy", "curious", "sad", "angry", "calm", "relaxed", "sleepy", "surprised"] as const,
        { description: "Mood to set" },
      ),
      strength: Type.Optional(Type.Number({ description: "0..1", minimum: 0, maximum: 1 })),
      decayMs: Type.Optional(Type.Number({ description: "How long the mood lingers, in ms" })),
    }),
    async execute(_id, params) {
      const out = await postJson("/vrm/mood", params);
      return {
        content: [{ type: "text", text: `Mood set to ${params.mood}` }],
        details: { tool: "vrm_mood", request: params, response: out },
      };
    },
  });
}
