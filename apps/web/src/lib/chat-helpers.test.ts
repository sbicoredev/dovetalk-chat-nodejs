import { describe, expect, it } from "vitest";

import type { ContactDto } from "@/lib/api/types";

import { isSavedContact } from "./chat-helpers";

function contact(over: Partial<ContactDto> = {}): ContactDto {
  return {
    id: "c1",
    name: "Priya Anand",
    phone: "+1 555 010 0142",
    about: "",
    hue: 10,
    avatarUrl: null,
    online: false,
    blocked: false,
    saved: true,
    ...over,
  };
}

describe("isSavedContact", () => {
  it("keeps saved contacts", () => {
    expect(isSavedContact(contact())).toBe(true);
  });

  it("drops people who only share a chat with the person, or were deleted", () => {
    expect(isSavedContact(contact({ saved: false }))).toBe(false);
  });

  it("treats data from before the field existed as saved", () => {
    const old = { ...contact(), saved: undefined } as unknown as ContactDto;
    expect(isSavedContact(old)).toBe(true);
  });
});
