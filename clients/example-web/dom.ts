export const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing example element: ${selector}`);
  return element;
};

export const maybe = <ElementType extends Element>(
  selector: string,
  root: ParentNode = document,
): ElementType | undefined => root.querySelector<ElementType>(selector) ?? undefined;

export const create = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
