/**
 * Filesystem-artifact primitives shared by recoverable stores.
 * Their implementation is currently retained with the mature recovery code;
 * consumers import this neutral seam rather than Quarantine.
 */
export {
  applyRestorationMetadata,
  copyArtifact,
  hashArtifact,
  inspectArtifact,
  mergeDirectoryArtifact,
  removeArtifact,
} from "../quarantine/integrity.js";
