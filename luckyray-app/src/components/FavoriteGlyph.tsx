import favoriteSvg from "../assets/icons/lightseek-ui-v2/favorite.svg?raw";
import "./favoriteGlyph.css";

const outlineMarkup = favoriteSvg.replace('aria-label="收藏"', 'aria-hidden="true" focusable="false"');
const filledMarkup = outlineMarkup.replace('fill="none"', 'fill="currentColor"');

export function FavoriteGlyph({ filled = false, className = "" }: { filled?: boolean; className?: string }) {
  return (
    <span
      className={`favorite-glyph${filled ? " is-filled" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: filled ? filledMarkup : outlineMarkup }}
    />
  );
}
