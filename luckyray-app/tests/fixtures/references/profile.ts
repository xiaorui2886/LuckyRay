import {
  CANVAS_MEDIA_PRESETS,
  type CanvasMediaProfile,
} from "../../../src/core/services/canvasMediaProfiles";
/** Reuse production protocol identifiers; no hand-written fake adapter names. */
export const REFERENCE_TEST_PROFILE = {
  ...CANVAS_MEDIA_PRESETS.agnes,
  id: "qa",
  revision: 1,
  apiKeyConfigured: true,
  name: "Synthetic QA",
  baseUrl: "https://fixture.invalid",
  imageProtocol: CANVAS_MEDIA_PRESETS.openai.imageProtocol,
  imageModel: "gpt-image-1",
} satisfies CanvasMediaProfile;
