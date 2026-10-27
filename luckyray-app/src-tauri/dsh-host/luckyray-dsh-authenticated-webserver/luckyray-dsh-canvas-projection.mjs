import { createHash } from 'node:crypto';

// Pure, model-facing transport projection. This cache is NOT evidence that a
// provider still knows a baseline: the caller must independently establish it.
const clone = value => JSON.parse(JSON.stringify(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values)].sort();
const withoutImage = ({ image, ...node }) => ({ ...node, ...(image ? { imageAttached: true } : {}) });

/**
 * full/includeImages are explicit reread escape hatches. epoch must identify a
 * verified consumer context window, not just a persisted conversation ID.
 * Reset baselineKnown on resume, compaction, turn changes or unknown continuity.
 * No implicit clipping: all supplied nodes are represented, with coverage.
 */
export function projectCanvasContext(context, previous, options = {}) {
  const epoch = options.epoch;
  const known = options.baselineKnown === true && typeof epoch === 'string' && epoch.length > 0
    && previous?.version === 1 && previous.epoch === epoch && previous.canvasId === context.canvasId
    && previous.nodeHashes && typeof previous.nodeHashes === 'object' && !Array.isArray(previous.nodeHashes)
    && previous.admittedImages && typeof previous.admittedImages === 'object' && !Array.isArray(previous.admittedImages)
    && typeof previous.metadataHash === 'string' && typeof previous.coverageHash === 'string';
  const full = options.full === true || options.forceFull === true || !known;
  const { nodes, ...metadata } = context;
  const nodeValues = nodes.map(withoutImage);
  const imageHashes = Object.fromEntries(nodes.filter(node => node.image).map(node => [node.id,
    fingerprint({ revision: node.revision, image: node.image })]));
  const hashes = Object.fromEntries(nodeValues.map(node => [node.id, fingerprint({ node, imageFingerprint: imageHashes[node.id] })]));
  const requiredImages = new Set(options.requiredVisualNodeIds ?? []);
  const images = nodes.filter(node => node.image && (full || options.includeImages === true
    || options.explicitVisualRead === true || requiredImages.has(node.id)
    || previous?.admittedImages?.[node.id] !== imageHashes[node.id]));
  const coverage = clone(options.coverage ?? context.coverage ?? {
    scope: 'supplied-working-set', complete: false, suppliedNodes: nodes.length,
    totalNodes: null, omittedNodes: null,
    notice: 'Only supplied working-set nodes are represented. An omitted ID is not evidence of deletion; explicitly read missing targets and full source pages.',
  });
  const absent = known ? Object.keys(previous.nodeHashes).filter(id => !Object.hasOwn(hashes, id)).sort() : [];
  const explicitDeleted = unique(options.deletedNodeIds ?? []);
  const deletedNodeIds = unique([...explicitDeleted, ...(coverage.complete === true ? absent : [])]);
  if (deletedNodeIds.some(id => Object.hasOwn(hashes, id))) throw new Error('canvas-projection-conflicting-tombstone');
  const removedFromWorkingSet = absent.filter(id => !deletedNodeIds.includes(id));
  const changed = full ? nodeValues : nodeValues.filter(node => previous.nodeHashes[node.id] !== hashes[node.id]);
  const metadataHash = fingerprint(metadata);
  const coverageHash = fingerprint(coverage);
  const mode = full ? 'full' : changed.length || absent.length || explicitDeleted.length
    || previous.metadataHash !== metadataHash || previous.coverageHash !== coverageHash ? 'delta' : 'unchanged';
  const projection = {
    ...clone(metadata), projectionVersion: 1, mode,
    baseRevision: full ? null : previous.snapshotRevision ?? null,
    snapshotRevision: context.snapshotRevision ?? null,
    nodes: clone(changed), deletedNodeIds, removedFromWorkingSet, coverage,
    counts: { supplied: nodes.length, changed: changed.length, unchanged: nodes.length - changed.length },
    ...(full ? { baselineReason: options.reason ?? (options.full || options.forceFull ? 'explicit-read' : 'unknown-consumer-baseline') } : {}),
    imageCoverage: {
      attachedNodeIds: images.map(node => node.id),
      retainedFromBaselineNodeIds: nodes.filter(node => node.image && !images.includes(node)).map(node => node.id),
      unavailableNodeIds: nodes.filter(node => node.imageUnavailable && !node.image).map(node => node.id),
      missingRequiredNodeIds: [...requiredImages].filter(id => !Object.hasOwn(imageHashes, id)).sort(),
    },
  };
  // Image identities are only retained if they were acknowledged in this same
  // verified consumer baseline. New candidates are NOT acknowledged here.
  const admittedImages = Object.fromEntries(Object.entries(known && !full ? previous.admittedImages ?? {} : {})
    .filter(([id, hash]) => imageHashes[id] === hash));
  return { projection, images, baseline: {
    version: 1, epoch, canvasId: context.canvasId, snapshotRevision: context.snapshotRevision,
    nodeHashes: hashes, metadataHash, coverageHash, imageHashes, admittedImages,
  } };
}

/** Call only for image IDs actually admitted into the successful tool result. */
export function acknowledgeProjectionImages(baseline, admittedNodeIds) {
  const next = clone(baseline);
  for (const id of admittedNodeIds) {
    if (!Object.hasOwn(next.imageHashes, id)) throw new Error('canvas-projection-unknown-image');
    next.admittedImages[id] = next.imageHashes[id];
  }
  return next;
}

/** Admission failed: make missing evidence explicit rather than claiming pixels. */
export function markProjectionImagesUnavailable(projection, nodeIds) {
  const unavailable = new Set(nodeIds);
  return { ...projection,
    nodes: projection.nodes.map(({ imageAttached, ...node }) => unavailable.has(node.id)
      ? { ...node, imageUnavailable: true } : { ...node, ...(imageAttached ? { imageAttached } : {}) }),
    imageCoverage: { ...projection.imageCoverage,
      attachedNodeIds: projection.imageCoverage.attachedNodeIds.filter(id => !unavailable.has(id)),
      unavailableNodeIds: unique([...projection.imageCoverage.unavailableNodeIds, ...nodeIds]),
    },
  };
}
