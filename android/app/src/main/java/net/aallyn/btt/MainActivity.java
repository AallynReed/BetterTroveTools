package net.aallyn.btt;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins BEFORE super.onCreate so the bridge
        // sees them when it builds the JS Capacitor.Plugins surface.
        registerPlugin(BttBatteryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
