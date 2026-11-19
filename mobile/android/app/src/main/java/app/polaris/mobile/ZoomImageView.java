package app.polaris.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.widget.ImageView;

/**
 * A picture that pinches to zoom, pans while zoomed and zooms on a double tap, the way a photo viewer does. The
 * picture is kept fitted to the view at its smallest and never panned past its own edges.
 */
final class ZoomImageView extends ImageView {
    private static final float MAX_ZOOM = 5f;
    private static final float DOUBLE_TAP_ZOOM = 2.5f;

    private final Matrix matrix = new Matrix();
    private final float[] values = new float[9];
    private final ScaleGestureDetector pinch;
    private final GestureDetector taps;
    /** The scale at which the picture just fits; zoom is measured from it. */
    private float fitScale = 1f;

    ZoomImageView(Context context) {
        super(context);
        setScaleType(ScaleType.MATRIX);
        pinch = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector detector) {
                zoomBy(detector.getScaleFactor(), detector.getFocusX(), detector.getFocusY());
                return true;
            }
        });
        taps = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent event) {
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent first, MotionEvent event, float dx, float dy) {
                if (zoom() <= 1.01f) return false;
                matrix.postTranslate(-dx, -dy);
                settle();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent event) {
                float target = zoom() > 1.01f ? 1f / zoom() : DOUBLE_TAP_ZOOM;
                zoomBy(target, event.getX(), event.getY());
                return true;
            }
        });
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        fit();
    }

    @Override
    public void setImageDrawable(Drawable drawable) {
        super.setImageDrawable(drawable);
        fit();
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(MotionEvent event) {
        pinch.onTouchEvent(event);
        taps.onTouchEvent(event);
        // Held while zoomed, so the screen behind does not read a pan as anything else.
        getParent().requestDisallowInterceptTouchEvent(zoom() > 1.01f || event.getPointerCount() > 1);
        return true;
    }

    /** How far in from the fitted size, 1 being fitted. */
    private float zoom() {
        matrix.getValues(values);
        return values[Matrix.MSCALE_X] / fitScale;
    }

    private void zoomBy(float factor, float x, float y) {
        float next = Math.max(1f, Math.min(MAX_ZOOM, zoom() * factor));
        float applied = next / zoom();
        matrix.postScale(applied, applied, x, y);
        settle();
    }

    private void fit() {
        Drawable drawable = getDrawable();
        if (drawable == null || getWidth() == 0 || getHeight() == 0) return;
        float width = drawable.getIntrinsicWidth();
        float height = drawable.getIntrinsicHeight();
        if (width <= 0 || height <= 0) return;
        fitScale = Math.min(getWidth() / width, getHeight() / height);
        matrix.setScale(fitScale, fitScale);
        matrix.postTranslate((getWidth() - width * fitScale) / 2f, (getHeight() - height * fitScale) / 2f);
        setImageMatrix(matrix);
    }

    /** Keep the picture centred where it is smaller than the view, and its edges inside the view where it is not. */
    private void settle() {
        Drawable drawable = getDrawable();
        if (drawable == null) return;
        RectF shown = new RectF(0, 0, drawable.getIntrinsicWidth(), drawable.getIntrinsicHeight());
        matrix.mapRect(shown);
        float dx = 0;
        float dy = 0;
        if (shown.width() <= getWidth()) dx = (getWidth() - shown.width()) / 2f - shown.left;
        else if (shown.left > 0) dx = -shown.left;
        else if (shown.right < getWidth()) dx = getWidth() - shown.right;
        if (shown.height() <= getHeight()) dy = (getHeight() - shown.height()) / 2f - shown.top;
        else if (shown.top > 0) dy = -shown.top;
        else if (shown.bottom < getHeight()) dy = getHeight() - shown.bottom;
        matrix.postTranslate(dx, dy);
        setImageMatrix(matrix);
    }
}
