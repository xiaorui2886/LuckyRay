/** Collapse whitespace only until the visible preview is filled. */
export function excerpt(text = "") {
  let result = "";
  let space = false;
  for (let index = 0; index < text.length && result.length < 56; index++) {
    const character = text[index];
    if (/\s/.test(character)) {
      space = result.length > 0;
    } else {
      if (space) result += " ";
      if (result.length < 56) result += character;
      space = false;
    }
  }
  return result;
}
