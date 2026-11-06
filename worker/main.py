"""
Processing worker — polls processing_jobs table, downloads recording batches
from Supabase Storage, concatenates them in order, validates with FFprobe,
and uploads the reconstructed file.

Implemented in Step 5 of Phase 0.
"""
