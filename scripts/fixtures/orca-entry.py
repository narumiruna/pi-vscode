"""Run real Orca with a line-buffered, bounded debug log. No speech/navigation stubs."""

import builtins
import runpy
import sys

_original_open = builtins.open
_LIMIT = 12 * 1024 * 1024


class ValidationLog:
    def __init__(self, stream):
        self.stream = stream
        self.size = 0
        self.truncated = False

    def write(self, text):
        self.size += len(text.encode("utf-8"))
        if self.size <= _LIMIT:
            return self.stream.write(text)
        if not self.truncated:
            self.stream.write("\nVALIDATION LOG LIMIT EXCEEDED\n")
            self.truncated = True
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def validation_open(file, mode="r", *args, **kwargs):
    if str(file).endswith("orca-debug.log") and mode == "w":
        kwargs["buffering"] = 1
        return ValidationLog(_original_open(file, mode, *args, **kwargs))
    return _original_open(file, mode, *args, **kwargs)


builtins.open = validation_open
entry = sys.argv.pop(1)
runpy.run_path(entry, run_name="__main__")
