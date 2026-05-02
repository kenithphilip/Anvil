import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Placeholder, placeholderFor } from "./placeholder.jsx";

describe("Placeholder", () => {
  it("renders the screen name as the title", () => {
    const { container } = render(<Placeholder name="My Day" />);
    expect(container.querySelector("h1").textContent).toBe("My Day");
  });
  it("includes a deep-link button to the legacy v3 build", () => {
    const { getByRole } = render(<Placeholder name="x" />);
    expect(getByRole("button").textContent.trim()).toMatch(/Open in legacy v3/);
  });
});

describe("placeholderFor", () => {
  it("returns a component that renders Placeholder bound to the name", () => {
    const Wrapped = placeholderFor("Foo Screen");
    const { container } = render(<Wrapped />);
    expect(container.querySelector("h1").textContent).toBe("Foo Screen");
  });
});
