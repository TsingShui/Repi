import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import { highlightCode } from "../lib/highlight";

const escapeHtml = MarkdownIt().utils.escapeHtml;
const markdown: MarkdownIt = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
  highlight(code, language) {
    const highlighted = highlightCode(code, language);
    return highlighted === null
      ? escapeHtml(code)
      : `<span class="hljs">${highlighted}</span>`;
  },
});

// Model-authored images must not trigger network requests from the page. Keep the
// useful alt text and URL visible as text instead.
const renderImage: RenderRule = (tokens, index) => {
  const token = tokens[index];
  if (!token) return "";
  const source = token.attrGet("src") ?? "";
  const alt = token.content || "image";
  return `<span class="markdown-image-link">[${escapeHtml(alt)}: ${escapeHtml(source)}]</span>`;
};
markdown.renderer.rules.image = renderImage;

const renderLinkOpen: RenderRule = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  if (!token) return "";
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer noopener");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_open = renderLinkOpen;

export function Markdown(props: { readonly text: string; readonly error?: boolean }) {
  const html = () => markdown.render(props.text);
  return (
    <div
      class="markdown-body"
      data-error={props.error ? "true" : "false"}
      innerHTML={html()}
    />
  );
}
