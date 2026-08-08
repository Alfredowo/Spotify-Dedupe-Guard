$ErrorActionPreference = 'Stop'

$shell = New-Object -ComObject Shell.Application
$thisPc = $shell.Namespace(17)
$device = $thisPc.Items() | Where-Object Name -eq 'POCO M5s' | Select-Object -First 1
if ($null -eq $device) { throw 'POCO M5s no está disponible.' }

$alfreRoot = $device.GetFolder.Items() | Where-Object Name -eq 'ALFRE' | Select-Object -First 1
$alfre = $alfreRoot.GetFolder.Items() | Where-Object Name -eq 'Alfre' | Select-Object -First 1
if ($null -eq $alfre) { throw 'No se encontró POCO M5s\ALFRE\Alfre.' }

function Normalize-Text([string]$Text) {
    $normalized = $Text.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
    return (($normalized.ToLowerInvariant() -replace '[^a-z0-9]+', ' ') -replace '\s+', ' ').Trim()
}

function Clean-FileStem([string]$Name) {
    $stem = [IO.Path]::GetFileNameWithoutExtension($Name)
    $stem = $stem -replace '(?i)\[listenvid\.com\]', ''
    $stem = $stem -replace '\s*\(\d+\)\s*$', ''
    $stem = $stem -replace '(?i)\b(official\s*(music\s*)?(video|audio)|lyrics?|letra|subtitulado|traducida?|sub\s*espa[nñ]ol|en\s*espa[nñ]ol|hd|hq|full\s*album\s*stream)\b', ''
    return (($stem -replace '[_]+', ' ') -replace '\s+', ' ').Trim(' ', '-', '_')
}

$files = @($alfre.GetFolder.Items() | Where-Object { -not $_.IsFolder })
$tracks = foreach ($file in $files) {
    $clean = Clean-FileStem $file.Name
    $parts = @($clean -split '\s+-\s+', 2)
    $artist = if ($parts.Count -eq 2) { $parts[0].Trim() } else { '' }
    $title = if ($parts.Count -eq 2) { $parts[1].Trim() } else { $clean }
    [pscustomobject]@{
        fileName = $file.Name
        cleanName = $clean
        artistHint = $artist
        titleHint = $title
        normalized = Normalize-Text $clean
        hasVersionMarker = [bool]($clean -match '(?i)\b(live|remaster(ed)?|radio edit|edit|remix|acoustic|album version|extended|original mix|demo)\b')
    }
}

$result = [pscustomobject]@{
    generatedAt = [DateTime]::UtcNow.ToString('o')
    source = 'POCO M5s\ALFRE\Alfre'
    count = $tracks.Count
    tracks = @($tracks)
}

$outputPath = Join-Path $PSScriptRoot 'spotify_phone_inventory.json'
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputPath -Encoding utf8
Write-Output $outputPath
