// Active scoring model. Swap the import to plug in another model exposing
// computeSubscores / computeIntensity / computeCurves / scoreFeatures.
export { computeSubscores, computeIntensity, computeCurves, scoreFeatures } from "./model.js";
