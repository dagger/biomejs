package main

import (
	"context"
	"dagger/biomego/internal/dagger"
)

type Biomego struct {
	Source           *dagger.Directory
	BaseImageAddress string
}

func New(
	//+defaultPath="/"
	source *dagger.Directory,

	//+default="node:25-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007"
	baseImageAddress string,
) *Biomego {
	return &Biomego{
		Source:           source,
		BaseImageAddress: baseImageAddress,
	}
}

// Returns a container that echoes whatever string argument is provided
func (m *Biomego) ContainerEcho(stringArg string) *dagger.Container {
	return dag.Container().From("alpine:latest").WithExec([]string{"echo", stringArg})
}

// Returns lines that match a pattern in the files of the provided Directory
func (m *Biomego) GrepDir(ctx context.Context, directoryArg *dagger.Directory, pattern string) (string, error) {
	return dag.Container().
		From("alpine:latest").
		WithMountedDirectory("/mnt", directoryArg).
		WithWorkdir("/mnt").
		WithExec([]string{"grep", "-R", pattern, "."}).
		Stdout(ctx)
}
