/* Plain-text offsets are UTF-16, matching DOM Range and reader-content ranges. */
function getReaderTextNodes(container) {
  const result = [];
  function visit(node, offset) {
    if (node.nodeType === 3) {
      const text = node.nodeValue || "";
      if (text) result.push({ node, start: offset, end: offset + text.length });
      return offset + text.length;
    }
    if (node.nodeType !== 1 && node !== container) return offset;
    if (node.hasAttribute?.("data-reader-auxiliary")) return offset;
    const explicit = node.getAttribute?.("data-reader-text-start");
    if (explicit !== null && explicit !== undefined && /^\d+$/.test(explicit)) offset = Number(explicit);
    for (const child of node.childNodes || []) offset = visit(child, offset);
    return offset;
  }
  if (container) visit(container, 0);
  return result;
}
