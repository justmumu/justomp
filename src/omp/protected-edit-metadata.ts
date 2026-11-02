import { type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  applyPatchSchema,
  hashlineEditParamsSchema,
  patchEditSchema,
  replaceEditSchema,
  resolveEditToolDescription,
  sloppyEditSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

const schemas = {
  apply_patch: applyPatchSchema,
  hashline: hashlineEditParamsSchema,
  patch: patchEditSchema,
  replace: replaceEditSchema,
  sloppy: sloppyEditSchema,
};

/** Native metadata and inspection must use the same provider-qualified selector. */
export function protectedEditMetadata(settings: Settings, model: ExtensionContext["model"]) {
  const mode = resolveEditMode({
    settings,
    getActiveModelString: () => (model ? formatModelString(model) : undefined),
  });
  return {
    mode,
    parameters: schemas[mode],
    description: resolveEditToolDescription(mode, model),
  };
}
