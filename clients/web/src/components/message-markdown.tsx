import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./message-markdown.css";

const safeUrl = (url: string): string => {
  const normalized = Array.from(url.trim())
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 32 && (codePoint < 127 || codePoint > 159);
    })
    .join("");
  const protocol = /^[a-z][a-z\d+.-]*:/i.exec(normalized)?.[0].toLocaleLowerCase();
  return protocol === undefined ||
    protocol === "http:" ||
    protocol === "https:" ||
    protocol === "mailto:"
    ? url
    : "";
};

export function MessageMarkdown({ children }: { readonly children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          a: ({ children: label, href }) =>
            href ? (
              <a href={href} rel="noreferrer">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            ),
          img: ({ alt, src }) =>
            src ? (
              <a className="markdown-image-link" href={src} rel="noreferrer">
                {alt ? `View image: ${alt}` : "View linked image"}
              </a>
            ) : (
              <span>{alt ?? "Image"}</span>
            ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
