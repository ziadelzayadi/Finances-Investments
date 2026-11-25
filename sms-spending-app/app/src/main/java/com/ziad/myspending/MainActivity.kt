package com.ziad.myspending

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The app is one screen: a WebView that shows the dashboard (assets/index.html).
 * This Kotlin file only does the things a web page cannot do on its own:
 *  - ask for SMS permission and read the SMS inbox
 *  - save/load your data in the app's private storage
 *  - back up / restore your data to a file you choose
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var pendingExport: String? = null

    companion object {
        private const val REQ_SMS = 1
        private const val REQ_EXPORT = 2
        private const val REQ_IMPORT = 3
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.webViewClient = object : WebViewClient() {
            // Never leave the app's own pages.
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = true
        }
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "Android")
        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) callJs("window.onAppResume && window.onAppResume()")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.onBack ? window.onBack() : false") { handled ->
            if (handled != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    private fun callJs(code: String) {
        runOnUiThread { web.evaluateJavascript(code, null) }
    }

    private fun hasSms(): Boolean =
        checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_SMS) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            // If Android will not show the dialog any more, the page offers to open App settings.
            val canAskAgain = shouldShowRequestPermissionRationale(Manifest.permission.READ_SMS)
            callJs("window.onSmsPermission && window.onSmsPermission($granted, $canAskAgain)")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        val uri: Uri? = data?.data
        if (requestCode == REQ_EXPORT) {
            val text = pendingExport
            pendingExport = null
            var ok = false
            if (resultCode == RESULT_OK && uri != null && text != null) {
                ok = try {
                    contentResolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    true
                } catch (e: Exception) { false }
            }
            callJs("window.onExportDone && window.onExportDone($ok)")
        } else if (requestCode == REQ_IMPORT) {
            var text: String? = null
            if (resultCode == RESULT_OK && uri != null) {
                text = try {
                    contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
                } catch (e: Exception) { null }
            }
            val arg = if (text == null) "null" else JSONObject.quote(text)
            callJs("window.onImportDone && window.onImportDone($arg)")
        }
    }

    /** Functions the page can call as Android.xxx(...) */
    inner class Bridge {

        @JavascriptInterface
        fun hasSmsPermission(): Boolean = hasSms()

        @JavascriptInterface
        fun requestSmsPermission() {
            runOnUiThread {
                if (hasSms()) callJs("window.onSmsPermission && window.onSmsPermission(true, true)")
                else requestPermissions(arrayOf(Manifest.permission.READ_SMS), REQ_SMS)
            }
        }

        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                startActivity(i)
            }
        }

        /**
         * Returns inbox SMS newer than [sinceMillis] as JSON:
         * [{"id":..,"address":"CIB","body":"...","date":1700000000000}, ...]
         * Only messages that contain a digit are returned (no amount = not a transaction).
         */
        @JavascriptInterface
        fun readSms(sinceMillis: Double): String {
            val out = JSONArray()
            if (!hasSms()) return out.toString()
            val projection = arrayOf(
                Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE
            )
            val cursor = contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI, projection,
                "${Telephony.Sms.DATE} > ?", arrayOf(sinceMillis.toLong().toString()),
                "${Telephony.Sms.DATE} ASC"
            ) ?: return out.toString()
            cursor.use { c ->
                val iId = c.getColumnIndexOrThrow(Telephony.Sms._ID)
                val iAddr = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val iBody = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val iDate = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
                while (c.moveToNext()) {
                    val body = c.getString(iBody) ?: continue
                    if (!body.any { it.isDigit() }) continue
                    val o = JSONObject()
                    o.put("id", c.getLong(iId))
                    o.put("address", c.getString(iAddr) ?: "")
                    o.put("body", body)
                    o.put("date", c.getLong(iDate))
                    out.put(o)
                }
            }
            return out.toString()
        }

        private val dataFile: File get() = File(filesDir, "data.json")

        @JavascriptInterface
        fun loadData(): String {
            val f = dataFile
            return if (f.exists()) f.readText(Charsets.UTF_8) else ""
        }

        @JavascriptInterface
        fun saveData(json: String): Boolean {
            return try {
                val tmp = File(filesDir, "data.json.tmp")
                tmp.writeText(json, Charsets.UTF_8)
                // Keep the previous save as a safety copy.
                if (dataFile.exists()) dataFile.copyTo(File(filesDir, "data.prev.json"), overwrite = true)
                tmp.renameTo(dataFile)
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun exportBackup(json: String, fileName: String) {
            runOnUiThread {
                pendingExport = json
                val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, fileName)
                }
                @Suppress("DEPRECATION")
                startActivityForResult(i, REQ_EXPORT)
            }
        }

        @JavascriptInterface
        fun importBackup() {
            runOnUiThread {
                val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                @Suppress("DEPRECATION")
                startActivityForResult(i, REQ_IMPORT)
            }
        }
    }
}
