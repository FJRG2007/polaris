// @vitest-environment jsdom
/**
 * The product image field sits inside the product form. Its buttons must not
 * be the form's submit: "Choose image" used to save and close the product
 * before the picker could open, so no file could ever be attached.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const picked = vi.hoisted(() => ({ choose: vi.fn(async () => [] as File[]), cropped: vi.fn() }));

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        filePicker: { useChooseFiles: () => [picked.choose, null] },
        imageCropper: { ImageCropDialog: (props: { file: Blob }) => <div role="dialog">crop {props.file.type}</div> }
    }
}));
vi.mock("@polaris-app/hospitality/src/screens/i18n", () => ({ useHospitalityT: () => (key: string) => key }));
vi.mock("@polaris/ui", async (load) => ({ ...(await load<object>()), useToast: () => ({ show: vi.fn() }) }));

const { PictureField } = await import("@polaris-app/hospitality/src/screens/picture-field");

afterEach(cleanup);

describe("hospitality image field in a form", () => {
    it("opens the shared picker without submitting the product form, then crops what was chosen", async () => {
        const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
        picked.choose.mockResolvedValueOnce([new File([new Uint8Array([1])], "dish.png", { type: "image/png" })]);
        render(
            <form onSubmit={submitted}>
                <PictureField value="" onChange={() => undefined} />
            </form>
        );
        fireEvent.click(screen.getByRole("button", { name: /picture.choose/ }));
        expect(submitted).not.toHaveBeenCalled();
        expect(picked.choose).toHaveBeenCalledWith(expect.objectContaining({ accept: expect.stringContaining("image/png") }));
        await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("image/png"));
    });

    it("removes the image without submitting the form", () => {
        const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
        const changed = vi.fn();
        render(
            <form onSubmit={submitted}>
                <PictureField value="/api/hospitality/images?i=local:x" onChange={changed} />
            </form>
        );
        fireEvent.click(screen.getByRole("button", { name: /picture.remove/ }));
        expect(submitted).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledWith("");
    });
});
