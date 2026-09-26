package org.anomychat.app;

import android.app.Activity;
import android.os.Build;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private Activity.ScreenCaptureCallback screenCaptureCallback;

    @Override
    public void onStart() {
        super.onStart();
        if (Build.VERSION.SDK_INT >= 34) {
            screenCaptureCallback = () -> {
                if (bridge != null && bridge.getWebView() != null) {
                    bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('sales-messenger-screenshot'))", null));
                }
            };
            registerScreenCaptureCallback(getMainExecutor(), screenCaptureCallback);
        }
    }

    @Override
    public void onStop() {
        if (Build.VERSION.SDK_INT >= 34 && screenCaptureCallback != null) {
            unregisterScreenCaptureCallback(screenCaptureCallback);
            screenCaptureCallback = null;
        }
        super.onStop();
    }
}
