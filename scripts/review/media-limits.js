const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
const VIDEO_MAX_SECONDS = 30 * 60;

// Проверенный слой длинного урока (automontage layer import): до 4 ГиБ и до 2 часов. Эти же значения –
// потолок опции limits у importReviewMedia: снять лимит совсем или поднять его выше нельзя.
const LAYER_IMPORT_LIMITS = Object.freeze({
  videoMaxBytes: 4 * 1024 * 1024 * 1024,
  videoMaxSeconds: 2 * 60 * 60,
});

module.exports = {
  IMAGE_MAX_BYTES,
  LAYER_IMPORT_LIMITS,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_SECONDS,
};
