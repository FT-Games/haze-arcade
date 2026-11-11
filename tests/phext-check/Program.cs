// Parses a .phext with PhantomHaze's real PhextParser and writes each app.page exactly as PhantomHaze would hand it
// to WebView2's NavigateToString (placeholders resolved with the default setting values, HTML context).
using System.Text;
using PhantomHaze;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: PhextCheck <file.phext> <out-dir> [key=value ...]");
    return 2;
}

string path = args[0];
string outDir = args[1];
Directory.CreateDirectory(outDir);

// File.ReadAllText is what the Import extension button uses.
string source = File.ReadAllText(path);
PhantomExtensionDefinition definition;
try
{
    definition = PhextParser.Parse(source, Path.GetFileName(path));
}
catch (PhextParseException ex)
{
    Console.WriteLine($"PARSE ERROR: {ex.Message}");
    return 1;
}

var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
foreach (PhantomExtensionSettingDefinition setting in definition.Settings)
{
    values[setting.Key] = setting.DefaultValue;
}

foreach (string pair in args.Skip(2))
{
    int eq = pair.IndexOf('=');
    values[pair[..eq]] = pair[(eq + 1)..];
}

Console.WriteLine($"id={definition.Id}");
Console.WriteLine($"name={definition.Name}");
Console.WriteLine($"version={definition.Version}");
Console.WriteLine($"description={definition.Description}");
Console.WriteLine($"icon={(definition.IconToken.Length > 60 ? definition.IconToken[..60] + "..." : definition.IconToken)} ({definition.IconToken.Length} chars)");
if (PhantomSvgDocument.TryDecodeDataUri(definition.IconToken, out string iconSvg))
{
    // PhantomExtensionIconFactory parses the SVG the same way before drawing it at 64x64.
    PhantomSvgDocument.Parse(iconSvg);
    Console.WriteLine("icon svg parsed OK");
}
foreach (PhantomExtensionSettingDefinition setting in definition.Settings)
{
    Console.WriteLine($"setting {setting.Key} [{setting.Type}] \"{setting.Label}\" default={setting.DefaultValue} min={setting.Minimum} max={setting.Maximum}");
}

Console.WriteLine($"menuItems={definition.MenuItems.Count} uiEdits={definition.UiEdits.Count} uiSvgs={definition.UiSvgs.Count} uiShapes={definition.UiShapes.Count} webScripts={definition.WebScripts.Count} webBlocks={definition.WebBlocks.Count} hasUi={definition.Ui.HasUi}");
foreach (PhantomExtensionUiEditDefinition edit in definition.UiEdits)
{
    Console.WriteLine($"ui.element {edit.Target} {edit.Property} text={edit.Text} color={edit.Color}");
}

foreach (PhantomExtensionUiSvgDefinition svg in definition.UiSvgs)
{
    Console.WriteLine($"ui.svg {svg.Target} parsed OK");
}

foreach (PhantomExtensionUiShapeDefinition shape in definition.UiShapes)
{
    Console.WriteLine($"ui.shape {shape.Target} {shape.Shape} fill={shape.Fill} outline={shape.Outline}");
}

// web.script blocks, built the way MainForm.BuildExtensionInjectionScript builds them for ExecuteScriptAsync.
var runtimeSettings = new Dictionary<string, object>(StringComparer.Ordinal);
foreach (PhantomExtensionSettingDefinition setting in definition.Settings)
{
    string value = values[setting.Key];
    runtimeSettings[setting.Key] = setting.Type switch
    {
        PhantomExtensionSettingType.Toggle => PhextParser.TryParseBoolean(value, out bool toggle) && toggle,
        PhantomExtensionSettingType.Number => int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int number) ? number : 0,
        _ => value,
    };
}

string contextJson = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
{
    ["id"] = definition.Id,
    ["name"] = definition.Name,
    ["version"] = definition.Version,
    ["settings"] = runtimeSettings,
});
foreach (PhantomExtensionWebScriptDefinition script in definition.WebScripts)
{
    string scriptSource = PhantomExtensionScriptBuilder.RewriteLegacyGlobalAccess(script.Content);
    string payload = PhantomExtensionPlaceholders.Resolve(scriptSource, definition, values, PhantomExtensionPlaceholderContext.JavaScriptString);
    string built = script.IsCss
        ? PhantomExtensionScriptBuilder.BuildStyleInjectionScript(definition.Id, script.Id, script.MatchPattern, payload)
        : PhantomExtensionScriptBuilder.BuildWebScript(contextJson, script.MatchPattern, payload);
    string file = Path.Combine(outDir, $"script-{script.Id}.js");
    File.WriteAllText(file, built, new UTF8Encoding(false));
    Console.WriteLine($"web.script {script.Id} pattern={script.MatchPattern} timing={script.Timing} chars={built.Length} -> {file}");
    foreach (string url in new[] { "https://ftgames.xyz/polytrack/#haze-arcade", "https://ftgames.xyz/games", "https://evil.example/?ftgames.xyz/" })
    {
        Console.WriteLine($"  matches {url}: {PhantomExtensionPatternMatcher.IsMatch(url, script.MatchPattern)}");
    }
}

foreach (PhantomExtensionPageDefinition page in definition.Pages)
{
    string resolved = PhantomExtensionPlaceholders.Resolve(page.Html, definition, values, PhantomExtensionPlaceholderContext.Html);
    bool completeDocument = page.Html.Contains("<html", StringComparison.OrdinalIgnoreCase);
    // ReadBlock uses AppendLine, so on Windows every line ends with \r\n.
    string windowsHtml = resolved.Replace("\r\n", "\n").Replace("\n", "\r\n");
    int utf8 = Encoding.UTF8.GetByteCount(windowsHtml);
    string file = Path.Combine(outDir, $"page-{page.Id}.html");
    File.WriteAllText(file, resolved, new UTF8Encoding(false));
    Console.WriteLine($"page {page.Id} label=\"{page.Label}\" completeDocument={completeDocument} chars={resolved.Length} windowsUtf8Bytes={utf8} base64DataUrlChars={(utf8 + 2) / 3 * 4 + 37} -> {file}");
}

return 0;
